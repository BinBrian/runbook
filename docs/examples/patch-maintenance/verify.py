"""Read-only checks for the fixed design example; no desktop or command execution."""

import copy
import json
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


BASE = Path(__file__).resolve().parent


def load(name):
    return json.loads((BASE / name).read_text(encoding="utf-8"))


def render(parts, values):
    return "".join(part if isinstance(part, str) else values[part["parameterId"]]
                   for part in parts)


def check_document(document):
    parameters = document["parameters"]
    parameter_ids = [p["id"] for p in parameters]
    assert len(parameter_ids) == len(set(parameter_ids))
    for parameter in parameters:
        assert all(isinstance(parameter[key], str)
                   for key in ("id", "name", "description", "defaultValue"))
        assert parameter["id"] and parameter["name"]
    step_ids = [step["id"] for step in document["steps"]]
    assert step_ids and len(step_ids) == len(set(step_ids))
    for step in document["steps"]:
        command_ids = [command["id"] for command in step["commands"]]
        assert len(command_ids) == len(set(command_ids))
        texts = [step["title"], step["description"]]
        texts += [command["text"] for command in step["commands"]]
        for parts in texts:
            assert isinstance(parts, list)
            for part in parts:
                if isinstance(part, str):
                    continue
                assert isinstance(part, dict) and set(part) == {"parameterId"}
                assert part["parameterId"] in parameter_ids
        assert all("status" not in command for command in step["commands"])


def check_instance(instance):
    assert instance["kind"] == "instance" and instance["formatVersion"] == 1
    check_document(instance["document"])
    parameter_ids = {p["id"] for p in instance["document"]["parameters"]}
    assert set(instance["parameterValues"]) == parameter_ids
    assert all(isinstance(value, str) for value in instance["parameterValues"].values())
    steps = instance["document"]["steps"]
    step_ids = [step["id"] for step in steps]
    entries = instance["entries"]
    assert len({entry["id"] for entry in entries}) == len(entries)
    assert [entry["at"] for entry in entries] == sorted(entry["at"] for entry in entries)
    assert all(entry["at"] <= instance["updatedAt"] for entry in entries)
    cursor = 0
    for entry in entries:
        assert entry["stepId"] in step_ids
        assert entry["type"] in ("result", "comment", "image")
        assert "output" not in entry
        if entry["type"] == "comment":
            assert isinstance(entry["text"], str)
        elif entry["type"] == "image":
            path = PurePosixPath(entry["path"])
            assert not path.is_absolute() and path.parts[0] == "images"
            assert ".." not in path.parts and "\\" not in entry["path"]
            assert entry["mediaType"] == "image/png"
        else:
            assert cursor < len(steps) and entry["stepId"] == step_ids[cursor]
            assert entry["outcome"] in ("completed", "failed", "skipped")
            if entry["outcome"] in ("failed", "skipped"):
                assert isinstance(entry["reason"], str) and entry["reason"].strip()
            snapshot = entry["snapshot"]
            assert isinstance(snapshot["title"], str)
            assert isinstance(snapshot["description"], str)
            assert all(isinstance(value, str) for value in snapshot["parameterValues"].values())
            assert all(isinstance(command["text"], str) and "status" not in command
                       for command in snapshot["commands"])
            if instance["finishedAt"]:
                assert entry["at"] <= instance["finishedAt"]
            if entry["outcome"] != "failed":
                cursor += 1
    status = instance["status"]
    assert status in ("draft", "in_progress", "completed", "terminated")
    if status == "in_progress":
        assert cursor < len(steps) and instance["currentStepId"] == step_ids[cursor]
        assert instance["finishedAt"] is None and instance["terminationReason"] is None
    else:
        assert instance["currentStepId"] is None
        if status == "completed":
            assert cursor == len(steps) and instance["finishedAt"]
            assert instance["terminationReason"] is None
        elif status == "terminated":
            assert cursor < len(steps) and instance["finishedAt"]
            assert instance["terminationReason"] and instance["terminationReason"].strip()
        else:
            assert cursor == 0 and not any(e["type"] == "result" for e in entries)
            assert instance["startedAt"] is None and instance["finishedAt"] is None
    return cursor


def main():
    template = load("template.runbook.json")
    instance = load("runbook.json")
    assert template["kind"] == "template" and template["formatVersion"] == 1
    assert "parameterValues" not in template and "entries" not in template
    check_document(template["document"])
    assert instance["document"] == template["document"]
    assert check_instance(instance) == 5
    assert len(instance["document"]["parameters"]) == 4
    results = [entry for entry in instance["entries"] if entry["type"] == "result"]
    assert [entry["outcome"] for entry in results] == [
        "completed", "failed", "completed", "skipped", "completed", "completed"]
    assert len(instance["document"]["steps"][1]["commands"]) == 2
    assert len(results[1]["snapshot"]["commands"]) == 2
    old_path = r"C:\RunbookDemo\packages\patch-0.1.1.zip"
    new_path = r"C:\RunbookDemo\packages\patch-0.1.1-repacked.zip"
    assert instance["parameterValues"]["packagePath"] == new_path
    assert results[1]["snapshot"]["parameterValues"]["packagePath"] == old_path
    assert results[1]["snapshot"]["commands"][1]["text"] == (
        "Get-FileHash -LiteralPath '" + old_path + "' -Algorithm SHA256")
    assert results[2]["snapshot"]["commands"][1]["text"] == (
        "Get-FileHash -LiteralPath '" + new_path + "' -Algorithm SHA256")
    assert instance["entries"][-1]["type"] == "comment"
    assert instance["entries"][-1]["at"] > instance["archivedAt"] > instance["finishedAt"]
    print("PASS: shape, parameter references, one-way results, reasons and old/new snapshots")

    running = copy.deepcopy(instance)
    running.update(status="in_progress", currentStepId="s2-package", finishedAt=None,
                   terminationReason=None, archivedAt=None, updatedAt="2026-10-20T01:04:00Z")
    running["entries"] = running["entries"][:4]
    assert check_instance(running) == 1
    terminated = copy.deepcopy(running)
    terminated.update(status="terminated", currentStepId=None,
                      finishedAt="2026-10-20T01:04:30Z", terminationReason="Demo stopped",
                      updatedAt="2026-10-20T01:04:30Z")
    assert check_instance(terminated) == 1
    work_copy = copy.deepcopy(terminated)
    work_copy.update(id="demo-work-copy", status="draft", startedAt=None, finishedAt=None,
                     terminationReason=None, archivedAt=None, entries=[],
                     createdAt="2026-10-20T01:30:00Z", updatedAt="2026-10-20T01:30:00Z")
    assert check_instance(work_copy) == 0
    assert work_copy["parameterValues"] == terminated["parameterValues"]
    assert work_copy["document"] == terminated["document"]
    assert len(terminated["entries"]) == 4 and len(instance["entries"]) == 9
    imported_copy = copy.deepcopy(instance)
    imported_copy["id"] = "demo-imported-copy"
    assert check_instance(imported_copy) == 5
    imported_copy["entries"][-1]["text"] = "Copy supplement"
    assert imported_copy["entries"][-1]["text"] != instance["entries"][-1]["text"]
    new_template = {"kind": "template", "id": "demo-new-template",
                    "formatVersion": 1, "document": copy.deepcopy(instance["document"])}
    defaults = {p["id"]: p["defaultValue"] for p in new_template["document"]["parameters"]}
    assert defaults["version"] == "0.1.0" != instance["parameterValues"]["version"]
    assert defaults["packagePath"] == "" and "entries" not in new_template
    assert render(["{{literal}} ", {"parameterId": "version"}], {"version": "0.1.1"}) == "{{literal}} 0.1.1"
    print("PASS: current-step projection, termination, work copy, import copy and original defaults")

    for mutation in ("blank_failure", "blank_skip", "out_of_order", "unknown_parameter"):
        invalid = copy.deepcopy(instance)
        if mutation == "blank_failure":
            invalid["entries"][1]["reason"] = " "
        elif mutation == "blank_skip":
            invalid["entries"][5]["reason"] = ""
        elif mutation == "out_of_order":
            invalid["entries"][1]["stepId"] = "s4-apply"
        else:
            invalid["document"]["steps"][0]["title"] = [{"parameterId": "missing"}]
        try:
            check_instance(invalid)
        except AssertionError:
            pass
        else:
            raise AssertionError("Invalid example accepted: " + mutation)
    print("PASS: rejects missing failure/skip reasons, out-of-order results and unknown references")

    with ZipFile(BASE / "patch-maintenance.runbook.zip") as archive:
        assert archive.testzip() is None
        images = {entry["path"] for entry in instance["entries"] if entry["type"] == "image"}
        assert len(archive.namelist()) == len(set(archive.namelist()))
        assert set(archive.namelist()) == {"runbook.json"} | images
        assert archive.read("runbook.json") == (BASE / "runbook.json").read_bytes()
        assert json.loads(archive.read("runbook.json")) == instance
        for path in images:
            content = archive.read(path)
            assert content == (BASE / path).read_bytes()
            assert content.startswith(b"\x89PNG\r\n\x1a\n")
    print("PASS: archive JSON, image references, image bytes and ZIP integrity")
    print("Design fixture checks only; no desktop feature or maintenance command was run.")


if __name__ == "__main__":
    main()
