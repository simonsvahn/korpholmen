#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "privat" / "migrering-2026-08-02"
SOURCE = MIGRATION / "initial-ops.json"
TARGET = MIGRATION / "korpholmenrunt.sqlite"

document = json.loads(SOURCE.read_text(encoding="utf-8"))
entities = {}
for operation in document["operations"]:
    key = (operation["entity_type"], operation["entity_id"])
    entities.setdefault(key, {})[operation["field"]] = operation["value"]

if TARGET.exists():
    TARGET.unlink()
db = sqlite3.connect(TARGET)
db.execute("PRAGMA foreign_keys = ON")
db.executescript("""
CREATE TABLE metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE source (id TEXT PRIMARY KEY, label TEXT NOT NULL, source_type TEXT, source_table TEXT, sha256 TEXT NOT NULL, imported_on TEXT, row_count INTEGER NOT NULL);
CREATE TABLE edition (id TEXT PRIMARY KEY, year INTEGER NOT NULL UNIQUE, result_count INTEGER NOT NULL, classes_json TEXT NOT NULL, course_codes_json TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES source(id));
CREATE TABLE person_ref (id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, island TEXT, living TEXT, url TEXT);
CREATE TABLE boat_ref (id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, type TEXT, period TEXT, owner_text TEXT, url TEXT);
CREATE TABLE result (id TEXT PRIMARY KEY, source_row_id INTEGER UNIQUE, source_id TEXT NOT NULL REFERENCES source(id), year INTEGER NOT NULL, boat_name_raw TEXT, boat_id TEXT, boat_match_status TEXT NOT NULL, captain_raw TEXT, crew_1_raw TEXT, crew_2_raw TEXT, class_raw TEXT, class_name TEXT NOT NULL, course_code TEXT NOT NULL, time_raw TEXT NOT NULL, duration_seconds INTEGER, time_status TEXT NOT NULL, notes TEXT, raw_json TEXT NOT NULL);
CREATE TABLE result_person (id TEXT PRIMARY KEY, result_id TEXT NOT NULL REFERENCES result(id), role TEXT NOT NULL, source_field TEXT NOT NULL, raw_name TEXT NOT NULL, person_id TEXT, match_status TEXT NOT NULL, match_method TEXT, candidate_ids_json TEXT NOT NULL, confirmed INTEGER NOT NULL CHECK (confirmed IN (0,1)));
CREATE TABLE source_note (id TEXT PRIMARY KEY, source_row_id INTEGER, note_text TEXT, raw_json TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES source(id));
CREATE INDEX idx_result_year_class_course ON result(year, class_name, course_code);
CREATE INDEX idx_result_duration ON result(course_code, duration_seconds) WHERE duration_seconds IS NOT NULL;
CREATE INDEX idx_result_boat ON result(boat_id, year) WHERE boat_id IS NOT NULL;
CREATE INDEX idx_result_person_person ON result_person(person_id, result_id) WHERE person_id IS NOT NULL;
CREATE INDEX idx_result_person_review ON result_person(match_status) WHERE match_status != 'kopplad';
""")

def rows(entity_type):
    return [(entity_id, fields) for (kind, entity_id), fields in entities.items() if kind == entity_type]

db.executemany("INSERT INTO metadata VALUES (?,?)", [
    ("migration_id", json.dumps(document["migration_id"], ensure_ascii=False)),
    ("source_sha256", json.dumps(document["source_sha256"])),
    ("counts", json.dumps(document["counts"], ensure_ascii=False, sort_keys=True)),
])
for entity_id, item in rows("race-source"):
    db.execute("INSERT INTO source VALUES (?,?,?,?,?,?,?)", (entity_id, item["label"], item.get("source_type"), item.get("source_table"), item["sha256"], item.get("imported_on"), item["row_count"]))
for entity_id, item in rows("race-edition"):
    db.execute("INSERT INTO edition VALUES (?,?,?,?,?,?)", (entity_id, item["year"], item["result_count"], json.dumps(item["classes"], ensure_ascii=False), json.dumps(item["course_codes"], ensure_ascii=False), item["source_id"]))
for entity_id, item in rows("person-ref"):
    db.execute("INSERT INTO person_ref VALUES (?,?,?,?,?,?)", (entity_id, item["external_id"], item["display_name"], item.get("island"), item.get("living"), item.get("url")))
for entity_id, item in rows("boat-ref"):
    db.execute("INSERT INTO boat_ref VALUES (?,?,?,?,?,?,?)", (entity_id, item["external_id"], item["name"], item.get("type"), item.get("period"), item.get("owner_text"), item.get("url")))
for entity_id, item in rows("race-result"):
    db.execute("INSERT INTO result VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        entity_id, item.get("source_row_id"), item["source_id"], item["year"], item.get("boat_name_raw"), item.get("boat_id"), item["boat_match_status"], item.get("captain_raw"), item.get("crew_1_raw"), item.get("crew_2_raw"), item.get("class_raw"), item["class_name"], item["course_code"], item["time_raw"], item.get("duration_seconds"), item["time_status"], item.get("notes"), json.dumps(item.get("raw_row"), ensure_ascii=False, sort_keys=True)
    ))
for entity_id, item in rows("race-person-link"):
    db.execute("INSERT INTO result_person VALUES (?,?,?,?,?,?,?,?,?,?)", (entity_id, item["result_id"], item["role"], item["source_field"], item["raw_name"], item.get("person_id"), item["match_status"], item.get("match_method"), json.dumps(item.get("candidate_ids", []), ensure_ascii=False), int(bool(item.get("confirmed")))))
for entity_id, item in rows("source-note"):
    db.execute("INSERT INTO source_note VALUES (?,?,?,?,?)", (entity_id, item.get("source_row_id"), item.get("note_text"), json.dumps(item.get("raw_row"), ensure_ascii=False, sort_keys=True), item["source_id"]))

db.commit()
violations = db.execute("PRAGMA foreign_key_check").fetchall()
if violations:
    raise RuntimeError(f"Foreign key-fel: {violations}")
db.execute("PRAGMA optimize")
plan = db.execute("EXPLAIN QUERY PLAN SELECT * FROM result WHERE year=? AND class_name=? AND course_code=?", (2001, "Kajak 2", "S")).fetchall()
if not any("idx_result_year_class_course" in str(row) for row in plan):
    raise RuntimeError(f"Förväntat index används inte: {plan}")
db.execute("VACUUM")
db.close()
print(json.dumps({"sqlite": str(TARGET), "bytes": TARGET.stat().st_size, "entities": len(entities)}, ensure_ascii=False))
