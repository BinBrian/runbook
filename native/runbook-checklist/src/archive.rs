use crate::{model::*, validate};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read, Write},
};
use zip::{write::FileOptions, ZipArchive, ZipWriter};

pub enum Imported {
    Template(Template),
    Instance(Instance),
    Block(Template),
}
pub struct ImportData {
    pub value: Imported,
    pub images: BTreeMap<String, Vec<u8>>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub token: String,
    pub kind: String,
    pub name: String,
    pub id: String,
    pub duplicate: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct ExportData {
    pub name: String,
    pub bytes: Vec<u8>,
}

fn json(bytes: &[u8]) -> Result<Imported, String> {
    validate::ensure(bytes.len() <= validate::MAX_FILE, "JSON 文件超过 32 MiB")?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("JSON 格式无效：{e}"))?;
    match value.get("kind").and_then(|k| k.as_str()) {
        Some("block") => {
            let block: Template =
                serde_json::from_value(value).map_err(|e| format!("步骤块结构无效：{e}"))?;
            validate::block(&block)?;
            Ok(Imported::Block(block))
        }
        Some("template") => {
            let t: Template =
                serde_json::from_value(value).map_err(|e| format!("模板结构无效：{e}"))?;
            validate::template(&t)?;
            Ok(Imported::Template(t))
        }
        Some("instance") => {
            let i: Instance =
                serde_json::from_value(value).map_err(|e| format!("实例结构无效：{e}"))?;
            validate::instance(&i)?;
            Ok(Imported::Instance(i))
        }
        _ => Err("仅支持清单模板、实例或步骤块".into()),
    }
}
pub fn parse(name: &str, bytes: &[u8]) -> Result<ImportData, String> {
    validate::ensure(
        !bytes.is_empty() && bytes.len() <= validate::MAX_FILE,
        "导入文件超过 32 MiB 或为空",
    )?;
    let mut images = BTreeMap::new();
    let value = if name.to_ascii_lowercase().ends_with(".zip") {
        let mut archive =
            ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("ZIP 存档无效：{e}"))?;
        validate::ensure(archive.len() <= 20002, "存档条目过多")?;
        let mut names = BTreeSet::new();
        let mut total = 0u64;
        let mut source = None;
        for index in 0..archive.len() {
            let mut file = archive
                .by_index(index)
                .map_err(|e| format!("无法读取存档：{e}"))?;
            let path = file.name().to_string();
            validate::ensure(names.insert(path.to_lowercase()), "存档包含重复路径")?;
            validate::ensure(
                file.unix_mode().is_none_or(|m| m & 0o170000 != 0o120000),
                "存档不得包含符号链接",
            )?;
            if file.is_dir() {
                validate::ensure(path == "images/", "存档含无效目录")?;
                continue;
            }
            validate::ensure(
                path == "runbook.json" || validate::image_path(&path).is_ok(),
                "存档路径无效或含额外文件",
            )?;
            let limit = if path == "runbook.json" {
                validate::MAX_FILE
            } else {
                validate::MAX_IMAGE
            };
            validate::ensure(file.size() <= limit as u64, "存档条目超过大小限制")?;
            total = total.checked_add(file.size()).ok_or("存档大小溢出")?;
            validate::ensure(
                total <= validate::MAX_UNPACKED as u64,
                "解包总量超过 64 MiB",
            )?;
            validate::ensure(
                file.size() <= file.compressed_size().max(1024).saturating_mul(1000),
                "存档压缩比异常",
            )?;
            let mut data = Vec::new();
            file.by_ref()
                .take((limit + 1) as u64)
                .read_to_end(&mut data)
                .map_err(|e| format!("存档内容损坏：{e}"))?;
            validate::ensure(
                data.len() <= limit && data.len() as u64 == file.size(),
                "存档声明大小与实际内容不一致",
            )?;
            if path == "runbook.json" {
                source = Some(data);
            } else {
                images.insert(path, data);
            }
        }
        json(&source.ok_or("存档缺少 runbook.json")?)?
    } else {
        validate::ensure(
            name.to_ascii_lowercase().ends_with(".json"),
            "请选择 .runbook.json 或 .runbook.zip",
        )?;
        json(bytes)?
    };
    let mut expected = BTreeSet::new();
    if let Imported::Instance(i) = &value {
        for entry in &i.entries {
            if let Entry::Image {
                path, media_type, ..
            } = entry
            {
                let data = images
                    .get(path)
                    .ok_or("存档缺少引用的图片；含图片的实例需使用 ZIP 导入")?;
                validate::image(data, media_type)?;
                expected.insert(path.as_str());
            }
        }
    }
    validate::ensure(images.len() == expected.len(), "存档包含未引用的图片")?;
    Ok(ImportData { value, images })
}
pub fn template(value: &Template) -> Result<ExportData, String> {
    let mut value = value.clone();
    value.format_version = 2;
    if value.kind == "block" {
        validate::block(&value)?;
    } else {
        validate::template(&value)?;
    }
    Ok(ExportData {
        name: format!(
            "{}.runbook.json",
            safe_name(&value.name).chars().take(80).collect::<String>()
        ),
        bytes: serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?,
    })
}
pub fn instance(
    value: &Instance,
    images: &BTreeMap<String, Vec<u8>>,
) -> Result<ExportData, String> {
    let mut value = value.clone();
    value.format_version = 2;
    validate::instance(&value)?;
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    writer
        .start_file("runbook.json", options)
        .map_err(|e| e.to_string())?;
    writer
        .write_all(&serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut total = 0usize;
    for entry in &value.entries {
        if let Entry::Image {
            path, media_type, ..
        } = entry
        {
            let bytes = images.get(path).ok_or("本地图片缺失，不能导出不完整存档")?;
            validate::image(bytes, media_type)?;
            total += bytes.len();
            validate::ensure(total <= validate::MAX_UNPACKED, "图片总量超过 64 MiB")?;
            writer
                .start_file(path, options)
                .map_err(|e| e.to_string())?;
            writer.write_all(bytes).map_err(|e| e.to_string())?;
        }
    }
    let bytes = writer.finish().map_err(|e| e.to_string())?.into_inner();
    validate::ensure(
        bytes.len() <= validate::MAX_FILE,
        "导出存档超过可导入的 32 MiB 限制",
    )?;
    // Run our importer before delivery so every exported archive is restorable.
    parse("export.runbook.zip", &bytes)?;
    Ok(ExportData {
        name: format!(
            "{}.runbook.zip",
            safe_name(&value.name).chars().take(80).collect::<String>()
        ),
        bytes,
    })
}
pub fn safe_name(value: &str) -> String {
    let value: String = value
        .chars()
        .take(100)
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let value = value.trim_matches([' ', '.']);
    if value.is_empty() {
        "Runbook".into()
    } else {
        value.into()
    }
}
