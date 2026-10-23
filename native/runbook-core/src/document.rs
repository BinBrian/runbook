use crate::model::*;
use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};
use serde::de::{self, MapAccess, Visitor};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    ops::Range,
};
use uuid::Uuid;

pub fn source_hash(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}

#[derive(Clone, Debug, PartialEq)]
enum MarkerKind {
    Document(String),
    Parameters(String),
    Step(String),
    EndStep,
    Command(String),
    Invalid,
}
#[derive(Clone, Debug)]
struct Marker {
    kind: MarkerKind,
    range: Range<usize>,
}
#[derive(Clone, Debug)]
struct Fence {
    range: Range<usize>,
    language: String,
}

fn quoted_attribute(text: &str, prefix: &str) -> Option<String> {
    text.strip_prefix(prefix)?
        .strip_suffix("\" -->")
        .map(str::to_owned)
}

// Only HTML block events at the document root may contain semantic markers.
// Code fences, block quotes, list items and inline HTML remain ordinary content.
fn scan(source: &str) -> (Vec<Marker>, Vec<Fence>) {
    let mut markers = Vec::new();
    let mut fences = Vec::new();
    let mut stack: Vec<TagEnd> = Vec::new();
    let mut semantic_html = false;
    for (event, range) in Parser::new(source).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if stack.is_empty() {
                    if matches!(&tag, Tag::HtmlBlock) {
                        let first = source[range.clone()].trim_start();
                        semantic_html = first.starts_with("<!-- runbook:")
                            || first.starts_with("<!-- /runbook:");
                    }
                    if let Tag::CodeBlock(CodeBlockKind::Fenced(info)) = &tag {
                        fences.push(Fence {
                            range: range.clone(),
                            language: info.split_whitespace().next().unwrap_or("").to_owned(),
                        });
                    }
                }
                stack.push(tag.to_end());
            }
            Event::End(_) => {
                stack.pop();
                if stack.is_empty() {
                    semantic_html = false;
                }
            }
            Event::Html(_) if semantic_html && stack == [TagEnd::HtmlBlock] => {
                let mut offset = range.start;
                for line in source[range].split_inclusive('\n') {
                    let text = line.trim();
                    if text.starts_with("<!-- runbook:") || text.starts_with("<!-- /runbook:") {
                        let kind = if text == "<!-- /runbook:step -->" {
                            MarkerKind::EndStep
                        } else if let Some(value) =
                            quoted_attribute(text, "<!-- runbook:document version=\"")
                        {
                            MarkerKind::Document(value)
                        } else if let Some(value) =
                            quoted_attribute(text, "<!-- runbook:step id=\"")
                        {
                            MarkerKind::Step(value)
                        } else if let Some(value) =
                            quoted_attribute(text, "<!-- runbook:command id=\"")
                        {
                            MarkerKind::Command(value)
                        } else if let Some(value) = text
                            .strip_prefix("<!-- runbook:parameters ")
                            .and_then(|value| value.strip_suffix(" -->"))
                        {
                            MarkerKind::Parameters(value.to_owned())
                        } else {
                            MarkerKind::Invalid
                        };
                        // Include indentation and the structural line ending in transformations.
                        let line_start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
                        let actual_start = if source[line_start..offset].trim().is_empty() {
                            line_start
                        } else {
                            offset
                        };
                        // pulldown-cmark omits CRLF from some HTML event ranges but
                        // includes LF. Extend to the physical line end consistently.
                        let line_end = source[offset..]
                            .find('\n')
                            .map_or(source.len(), |index| offset + index + 1);
                        markers.push(Marker {
                            kind,
                            range: actual_start..line_end,
                        });
                    }
                    offset += line.len();
                }
            }
            _ => {}
        }
    }
    (markers, fences)
}

fn diagnostic(
    diagnostics: &mut Vec<Diagnostic>,
    source: &str,
    offset: usize,
    message: impl Into<String>,
) {
    diagnostics.push(Diagnostic {
        message: message.into(),
        line: source[..offset.min(source.len())]
            .bytes()
            .filter(|b| *b == b'\n')
            .count() as u32
            + 1,
    });
}

fn valid_id(value: &str) -> Option<String> {
    Uuid::parse_str(value).ok().map(|id| id.to_string())
}

fn fence_text(source: &str, fence: &Fence) -> Result<String, String> {
    let block = &source[fence.range.clone()];
    let opener_end = block.find('\n').ok_or("指令围栏尚未闭合")? + 1;
    let opener = block[..opener_end].trim_start();
    let delimiter = opener.as_bytes().first().copied().ok_or("无效指令围栏")?;
    let count = opener.bytes().take_while(|b| *b == delimiter).count();
    if !matches!(delimiter, b'`' | b'~') || count < 3 {
        return Err("无效指令围栏".into());
    }
    let no_final_eol = block
        .strip_suffix("\r\n")
        .or_else(|| block.strip_suffix('\n'))
        .unwrap_or(block);
    let closing_start = no_final_eol.rfind('\n').map_or(0, |index| index + 1);
    if closing_start < opener_end {
        return Err("指令围栏尚未闭合".into());
    }
    let closing_line = &no_final_eol[closing_start..];
    let indentation = closing_line.bytes().take_while(|b| *b == b' ').count();
    let closing = &closing_line[indentation..];
    let closing_count = closing.bytes().take_while(|b| *b == delimiter).count();
    if indentation > 3 || closing_count < count || !closing[closing_count..].trim().is_empty() {
        return Err("指令围栏尚未闭合".into());
    }
    let body = &block[opener_end..closing_start];
    // Remove exactly one syntax separator, never trim command whitespace.
    let text = body
        .strip_suffix("\r\n")
        .or_else(|| body.strip_suffix('\n'))
        .unwrap_or(body);
    if text.trim().is_empty() {
        return Err("指令正文不能为空或只有空白".into());
    }
    Ok(text.to_owned())
}

fn title(markdown: &str) -> Option<String> {
    let mut heading = false;
    let mut result = String::new();
    for event in Parser::new(markdown) {
        match event {
            Event::Start(Tag::Heading { .. }) => {
                heading = true;
            }
            Event::Text(text) | Event::Code(text) if heading => result.push_str(&text),
            Event::SoftBreak | Event::HardBreak if heading => result.push(' '),
            Event::End(TagEnd::Heading(_)) if heading => {
                if !result.trim().is_empty() {
                    return Some(result.trim().to_owned());
                }
                heading = false;
            }
            _ => {}
        }
    }
    markdown
        .lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty()
                && !line.starts_with("<!--")
                && !line.starts_with("```")
                && !line.starts_with("~~~")
        })
        .map(str::to_owned)
}

pub fn valid_parameter_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

struct ParameterDefinitions(Vec<ParameterDefinition>);

impl<'de> Deserialize<'de> for ParameterDefinitions {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DefinitionsVisitor;
        impl<'de> Visitor<'de> for DefinitionsVisitor {
            type Value = ParameterDefinitions;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str(
                    "a JSON object containing unique parameter names and string defaults",
                )
            }

            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut names = HashSet::new();
                let mut definitions = Vec::new();
                while let Some((name, default_value)) = map.next_entry::<String, String>()? {
                    if !valid_parameter_name(&name) {
                        return Err(de::Error::custom(format!("无效参数名：{name}")));
                    }
                    if !names.insert(name.clone()) {
                        return Err(de::Error::custom(format!("参数名重复：{name}")));
                    }
                    definitions.push(ParameterDefinition {
                        name,
                        default_value,
                    });
                }
                Ok(ParameterDefinitions(definitions))
            }
        }
        deserializer.deserialize_map(DefinitionsVisitor)
    }
}

// Placeholder ranges refer only to the original source. Inserted values are never scanned again.
fn placeholders(source: &str) -> Result<Vec<(Range<usize>, &str)>, (usize, String)> {
    let mut found = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = source[cursor..].find("{{rb:") {
        let start = cursor + relative;
        let name_start = start + "{{rb:".len();
        let Some(close) = source[name_start..].find("}}") else {
            return Err((start, "参数占位符尚未闭合".into()));
        };
        let end = name_start + close + 2;
        let name = &source[name_start..name_start + close];
        if !valid_parameter_name(name) {
            return Err((start, format!("无效参数占位符：{name}")));
        }
        found.push((start..end, name));
        cursor = end;
    }
    Ok(found)
}

fn replace_parameters(
    source: &str,
    parameters: &BTreeMap<String, String>,
) -> Result<String, String> {
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0;
    for (range, name) in placeholders(source).map_err(|(_, error)| error)? {
        let value = parameters
            .get(name)
            .ok_or_else(|| format!("未声明的参数：{name}"))?;
        output.push_str(&source[cursor..range.start]);
        output.push_str(value);
        cursor = range.end;
    }
    output.push_str(&source[cursor..]);
    Ok(output)
}

pub fn parse_document(source: &str) -> Document {
    parse_document_structure(source, true)
}

// Resolved and historical snapshots are already literal text and must not be interpolated twice.
pub(crate) fn parse_document_structure(source: &str, check_parameters: bool) -> Document {
    let mut result = Document {
        parameters: vec![],
        steps: vec![],
        diagnostics: vec![],
        source_hash: source_hash(source),
    };
    if source.len() > u32::MAX as usize {
        result.diagnostics.push(Diagnostic {
            message: "文档超过支持的大小".into(),
            line: 1,
        });
        return result;
    }
    let (markers, fences) = scan(source);
    let mut document_count = 0;
    let mut parameter_count = 0;
    let mut step_ids = HashSet::new();
    let mut command_ids = HashSet::new();
    let mut open_step: Option<(Marker, String, Vec<CommandDefinition>)> = None;
    for marker in &markers {
        match &marker.kind {
            MarkerKind::Parameters(json) => {
                parameter_count += 1;
                if parameter_count > 1 {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "参数定义标记重复",
                    );
                }
                if open_step.is_some() {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "参数定义必须位于步骤外部",
                    );
                }
                match serde_json::from_str::<ParameterDefinitions>(json) {
                    Ok(definitions) => {
                        if parameter_count == 1 {
                            result.parameters = definitions.0;
                        }
                    }
                    Err(error) => diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        format!("参数定义无效：{error}"),
                    ),
                }
            }
            MarkerKind::Document(version) => {
                document_count += 1;
                if document_count > 1 {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "文档格式标记重复",
                    );
                }
                if version != "1" {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        format!("不支持的 Runbook 文档版本：{version}"),
                    );
                }
                if open_step.is_some() {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "文档格式标记不能位于步骤内部",
                    );
                }
            }
            MarkerKind::Step(value) => {
                if open_step.is_some() {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "步骤不能嵌套",
                    );
                    continue;
                }
                let id = valid_id(value).unwrap_or_else(|| {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "步骤 ID 必须为 UUID",
                    );
                    value.clone()
                });
                if !step_ids.insert(id.clone()) {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "步骤 ID 重复",
                    );
                }
                open_step = Some((marker.clone(), id, vec![]));
            }
            MarkerKind::EndStep => {
                if let Some((start, id, commands)) = open_step.take() {
                    let markdown = source[start.range.end..marker.range.start].to_owned();
                    let heading = title(&markdown).unwrap_or_else(|| {
                        diagnostic(
                            &mut result.diagnostics,
                            source,
                            start.range.start,
                            "步骤缺少可读标题或正文",
                        );
                        "无标题步骤".to_owned()
                    });
                    result.steps.push(StepDefinition {
                        id,
                        title: heading,
                        content_hash: source_hash(&markdown.replace("\r\n", "\n")),
                        markdown,
                        commands,
                        start: start.range.start as u32,
                        end: marker.range.end as u32,
                    });
                } else {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "结束标记没有对应的步骤",
                    );
                }
            }
            MarkerKind::Command(value) => {
                let Some((_, _, commands)) = &mut open_step else {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "指令必须位于步骤内部",
                    );
                    continue;
                };
                let id = valid_id(value).unwrap_or_else(|| {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "指令 ID 必须为 UUID",
                    );
                    value.clone()
                });
                if !command_ids.insert(id.clone()) {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "指令 ID 重复",
                    );
                }
                let candidate = fences
                    .iter()
                    .find(|fence| fence.range.start >= marker.range.end);
                if let Some(fence) = candidate.filter(|fence| {
                    source[marker.range.end..fence.range.start]
                        .trim()
                        .is_empty()
                }) {
                    match fence_text(source, fence) {
                        Ok(text) => commands.push(CommandDefinition {
                            id,
                            language: fence.language.clone(),
                            text,
                            start: fence.range.start as u32,
                            end: fence.range.end as u32,
                        }),
                        Err(error) => {
                            diagnostic(&mut result.diagnostics, source, marker.range.start, error)
                        }
                    }
                } else {
                    diagnostic(
                        &mut result.diagnostics,
                        source,
                        marker.range.start,
                        "指令标记后必须紧接顶层代码围栏，中间只允许空行",
                    );
                }
            }
            MarkerKind::Invalid => diagnostic(
                &mut result.diagnostics,
                source,
                marker.range.start,
                "无效 Runbook 标记",
            ),
        }
    }
    if let Some((marker, _, _)) = open_step {
        diagnostic(
            &mut result.diagnostics,
            source,
            marker.range.start,
            "步骤尚未闭合",
        );
    }
    if document_count == 0 && !markers.is_empty() {
        diagnostic(
            &mut result.diagnostics,
            source,
            0,
            "交互文档缺少 runbook:document 格式标记",
        );
    }
    if check_parameters {
        if fence_structure(source)
            .iter()
            .any(|(_, open, close)| open.contains("{{rb:") || close.contains("{{rb:"))
        {
            diagnostic(
                &mut result.diagnostics,
                source,
                0,
                "围栏语言和边界不能使用参数",
            );
        }
        let names: HashSet<&str> = result
            .parameters
            .iter()
            .map(|parameter| parameter.name.as_str())
            .collect();
        let mut cursor = 0;
        for range in markers
            .iter()
            .filter_map(|marker| {
                matches!(marker.kind, MarkerKind::Parameters(_)).then_some(marker.range.clone())
            })
            .chain(std::iter::once(source.len()..source.len()))
        {
            match placeholders(&source[cursor..range.start]) {
                Ok(placeholders) => {
                    for (placeholder, name) in placeholders {
                        if !names.contains(name) {
                            diagnostic(
                                &mut result.diagnostics,
                                source,
                                cursor + placeholder.start,
                                format!("未声明的参数：{name}"),
                            );
                        }
                    }
                }
                Err((offset, error)) => {
                    diagnostic(&mut result.diagnostics, source, cursor + offset, error)
                }
            }
            cursor = range.end;
        }
    }
    result
}

// Fence boundaries and their container ancestry cannot be supplied by a variable.
// Including unmarked/nested fences also catches changes outside interactive command blocks.
fn fence_structure(source: &str) -> Vec<(String, String, String)> {
    let mut stack = Vec::new();
    let mut fences = Vec::new();
    for (event, range) in Parser::new(source).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if let Tag::CodeBlock(CodeBlockKind::Fenced(_)) = &tag {
                    let text = source[range].trim_end_matches(['\r', '\n']);
                    fences.push((
                        format!("{stack:?}"),
                        text.lines().next().unwrap_or("").to_owned(),
                        text.lines().last().unwrap_or("").to_owned(),
                    ));
                }
                stack.push(tag.to_end());
            }
            Event::End(_) => {
                stack.pop();
            }
            _ => {}
        }
    }
    fences
}

pub fn resolve_document(
    markdown: &str,
    parameters: &BTreeMap<String, String>,
) -> Result<ResolvedDocument, String> {
    let source = parse_document(markdown);
    if !source.diagnostics.is_empty() {
        return Err(source
            .diagnostics
            .iter()
            .map(|item| format!("第 {} 行：{}", item.line, item.message))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let parameters: BTreeMap<String, String> = source
        .parameters
        .iter()
        .map(|definition| {
            (
                definition.name.clone(),
                parameters
                    .get(&definition.name)
                    .unwrap_or(&definition.default_value)
                    .clone(),
            )
        })
        .collect();
    for value in parameters.values() {
        if value.contains("<!-- runbook:") || value.contains("<!-- /runbook:") {
            return Err("参数值不能注入 Runbook 语义标记".into());
        }
    }
    let original_fences = fence_structure(markdown);
    if original_fences
        .iter()
        .any(|(_, open, close)| open.contains("{{rb:") || close.contains("{{rb:"))
    {
        return Err("围栏语言和边界不能使用参数".into());
    }
    let (markers, _) = scan(markdown);
    let mut resolved = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for marker in markers
        .iter()
        .filter(|marker| matches!(marker.kind, MarkerKind::Parameters(_)))
    {
        resolved.push_str(&replace_parameters(
            &markdown[cursor..marker.range.start],
            &parameters,
        )?);
        resolved.push_str(&markdown[marker.range.clone()]);
        cursor = marker.range.end;
    }
    resolved.push_str(&replace_parameters(&markdown[cursor..], &parameters)?);
    let document = parse_document_structure(&resolved, false);
    if !document.diagnostics.is_empty() {
        return Err(format!(
            "参数替换破坏文档结构：{}",
            document.diagnostics[0].message
        ));
    }
    let (resolved_markers, _) = scan(&resolved);
    if markers
        .iter()
        .map(|marker| &marker.kind)
        .ne(resolved_markers.iter().map(|marker| &marker.kind))
        || original_fences != fence_structure(&resolved)
        || source.steps.len() != document.steps.len()
    {
        return Err("参数替换不能改变 Runbook 标记或代码围栏结构".into());
    }
    for (original, actual) in source.steps.iter().zip(&document.steps) {
        if original.id != actual.id
            || original.commands.len() != actual.commands.len()
            || replace_parameters(&original.markdown, &parameters)? != actual.markdown
        {
            return Err("参数替换不能改变步骤身份或边界".into());
        }
        for (original, actual) in original.commands.iter().zip(&actual.commands) {
            if original.id != actual.id
                || original.language != actual.language
                || replace_parameters(&original.text, &parameters)? != actual.text
            {
                return Err("参数替换不能改变指令身份、语言或边界".into());
            }
        }
    }
    Ok(ResolvedDocument {
        markdown: resolved,
        document,
        parameters,
    })
}

pub fn plain_markdown(source: &str) -> Result<String, String> {
    let document = parse_document(source);
    if !document.diagnostics.is_empty() {
        return Err("请先修复文档标记错误，再导出普通 Markdown".into());
    }
    Ok(strip_markers(source))
}

pub fn plain_resolved_markdown(
    source: &str,
    parameters: &BTreeMap<String, String>,
) -> Result<String, String> {
    let resolved = resolve_document(source, parameters)?;
    Ok(strip_markers(&resolved.markdown))
}

fn strip_markers(source: &str) -> String {
    let (markers, _) = scan(source);
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0;
    for marker in markers {
        output.push_str(&source[cursor..marker.range.start]);
        cursor = marker.range.end;
    }
    output.push_str(&source[cursor..]);
    output
}
