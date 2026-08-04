#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "privat" / "migrering-2026-08-02"
SOURCE = MIGRATION / "research-export.json"
TARGET = MIGRATION / "fastighetshistorik.sqlite"

data = json.loads(SOURCE.read_text(encoding="utf-8"))
if TARGET.exists():
    TARGET.unlink()

connection = sqlite3.connect(TARGET)
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript("""
CREATE TABLE metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE source (id TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT, path TEXT, status TEXT);
CREATE TABLE property (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, island TEXT, label TEXT, wiki_page TEXT, canonical_master TEXT NOT NULL);
CREATE TABLE historical_unit (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, valid_from TEXT, valid_to TEXT, data_json TEXT NOT NULL);
CREATE TABLE party (id TEXT PRIMARY KEY, name TEXT NOT NULL, party_type TEXT NOT NULL, person_id TEXT, identity_status TEXT NOT NULL);
CREATE TABLE property_event (id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, contract_date TEXT, possession_date TEXT, application_date TEXT, survey_date TEXT, approval_date TEXT, date_text TEXT, amount REAL, currency TEXT, data_json TEXT NOT NULL);
CREATE TABLE event_property (event_id TEXT NOT NULL REFERENCES property_event(id), property_id TEXT NOT NULL REFERENCES property(id), PRIMARY KEY(event_id, property_id));
CREATE TABLE event_party (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES property_event(id), party_id TEXT NOT NULL REFERENCES party(id), role TEXT NOT NULL);
CREATE TABLE holding (id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, party_id TEXT NOT NULL REFERENCES party(id), role TEXT NOT NULL, start_date TEXT, end_date TEXT, observed_on TEXT, certainty TEXT, basis TEXT, data_json TEXT NOT NULL);
CREATE TABLE holding_claim (id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES property(id), party_id TEXT REFERENCES party(id), holder_text TEXT NOT NULL, role TEXT NOT NULL, period_text TEXT, start_year INTEGER, start_year_min INTEGER, start_year_max INTEGER, end_year INTEGER, end_year_min INTEGER, end_year_max INTEGER, certainty TEXT NOT NULL, verification_status TEXT NOT NULL, raw_text TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE event_claim (id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, date_text TEXT, year_min INTEGER, year_max INTEGER, amount REAL, currency TEXT, certainty TEXT NOT NULL, verification_status TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE event_claim_property (event_claim_id TEXT NOT NULL REFERENCES event_claim(id), property_id TEXT NOT NULL REFERENCES property(id), PRIMARY KEY(event_claim_id, property_id));
CREATE TABLE ownership_observation (id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES property(id), observed_on TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES source(id), data_json TEXT NOT NULL);
CREATE TABLE current_owner_assessment (id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES property(id), reviewed_on TEXT NOT NULL, status TEXT NOT NULL, basis TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE current_owner_party (assessment_id TEXT NOT NULL REFERENCES current_owner_assessment(id), party_id TEXT NOT NULL REFERENCES party(id), PRIMARY KEY(assessment_id, party_id));
CREATE TABLE property_relation (id TEXT PRIMARY KEY, from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_property_id TEXT NOT NULL REFERENCES property(id), relation TEXT NOT NULL, event_id TEXT REFERENCES property_event(id), certainty TEXT, data_json TEXT NOT NULL);
CREATE TABLE community_link (id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES property(id), person_id TEXT NOT NULL, person_display_name TEXT NOT NULL, relation TEXT NOT NULL, legal_ownership INTEGER NOT NULL CHECK (legal_ownership IN (0,1)), confirmed INTEGER NOT NULL CHECK (confirmed IN (0,1)));
CREATE TABLE manual_claim (id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES property(id), claim_order INTEGER NOT NULL, text TEXT NOT NULL, role TEXT NOT NULL, normalized INTEGER NOT NULL CHECK (normalized IN (0,1)), normalized_entity_type TEXT NOT NULL, normalized_entity_id TEXT NOT NULL);
CREATE TABLE audit_finding (id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES property(id), status TEXT NOT NULL, severity TEXT NOT NULL, summary TEXT NOT NULL, reviewed_on TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE rejected_claim (id TEXT PRIMARY KEY, property_id TEXT NOT NULL REFERENCES property(id), claim TEXT NOT NULL, reason TEXT NOT NULL, locator TEXT, reviewed_on TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE evidence (id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES source(id), locator TEXT, stance TEXT NOT NULL);
CREATE INDEX idx_event_dates ON property_event(contract_date, possession_date, approval_date);
CREATE INDEX idx_holding_subject ON holding(subject_type, subject_id);
CREATE INDEX idx_holding_party ON holding(party_id);
CREATE INDEX idx_holding_claim_property_year ON holding_claim(property_id, start_year_min, end_year_max);
CREATE INDEX idx_event_claim_year ON event_claim(year_min, year_max);
CREATE INDEX idx_observation_property_date ON ownership_observation(property_id, observed_on);
CREATE INDEX idx_current_owner_property ON current_owner_assessment(property_id, reviewed_on);
CREATE INDEX idx_audit_status ON audit_finding(status, severity);
CREATE INDEX idx_community_person ON community_link(person_id);
""")

tables = data["tables"]
connection.executemany("INSERT INTO metadata VALUES (?, ?)", [
    ("dataset", json.dumps(data["dataset"], ensure_ascii=False)),
    ("generated_on", json.dumps(data["generated_on"], ensure_ascii=False)),
    ("source_sha256", json.dumps(data["source_sha256"])),
    ("counts", json.dumps(data["counts"], ensure_ascii=False, sort_keys=True)),
])
connection.executemany("INSERT INTO source VALUES (:id,:label,:type,:path,:status)", tables["source"])
connection.executemany("INSERT INTO property VALUES (:id,:display_name,:island,:label,:wiki_page,:canonical_master)", tables["property"])
connection.executemany("INSERT INTO historical_unit VALUES (?,?,?,?,?)", [
    (row["id"], row["display_name"], row.get("valid_from"), row.get("valid_to"), json.dumps(row, ensure_ascii=False, sort_keys=True)) for row in tables["historical-unit"]
])
connection.executemany("INSERT INTO party VALUES (:id,:name,:party_type,:person_id,:identity_status)", tables["party"])
for row in tables["event"]:
    connection.execute("INSERT INTO property_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
        row["id"], row["type"], row["label"], row.get("contract_date"), row.get("possession_date"), row.get("application_date"),
        row.get("survey_date"), row.get("approval_date"), row.get("date_text"), row.get("amount"), row.get("currency"),
        json.dumps(row, ensure_ascii=False, sort_keys=True)
    ))
    connection.executemany("INSERT INTO event_property VALUES (?,?)", [(row["id"], property_id) for property_id in row["property_ids"]])
connection.executemany("INSERT INTO event_party VALUES (:id,:event_id,:party_id,:role)", tables["event-party"])
connection.executemany("INSERT INTO holding VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    (row["id"], row["subject_type"], row["subject_id"], row["party_id"], row["role"], row.get("start_date"), row.get("end_date"),
     row.get("observed_on"), row.get("certainty"), row.get("basis"), json.dumps(row, ensure_ascii=False, sort_keys=True)) for row in tables["holding"]
])
connection.executemany("INSERT INTO holding_claim VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
    (row["id"], row["property_id"], row.get("party_id"), row["holder_text"], row["role"], row.get("period_text"),
     row.get("start_year"), row.get("start_year_min"), row.get("start_year_max"), row.get("end_year"), row.get("end_year_min"),
     row.get("end_year_max"), row["certainty"], row["verification_status"], row["raw_text"],
     json.dumps(row, ensure_ascii=False, sort_keys=True)) for row in tables["holding-claim"]
])
for row in tables["event-claim"]:
    connection.execute("INSERT INTO event_claim VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
        row["id"], row["type"], row["label"], row.get("date_text"), row.get("year_min"), row.get("year_max"),
        row.get("amount"), row.get("currency"), row["certainty"], row["verification_status"],
        json.dumps(row, ensure_ascii=False, sort_keys=True)
    ))
    connection.executemany("INSERT INTO event_claim_property VALUES (?,?)", [(row["id"], property_id) for property_id in row["property_ids"]])
connection.executemany("INSERT INTO ownership_observation VALUES (?,?,?,?,?)", [
    (row["id"], row["property_id"], row["observed_on"], row["source_id"], json.dumps(row, ensure_ascii=False, sort_keys=True)) for row in tables["observation"]
])
for row in tables["current-owner-assessment"]:
    connection.execute("INSERT INTO current_owner_assessment VALUES (?,?,?,?,?,?)", (
        row["id"], row["property_id"], row["reviewed_on"], row["status"], row["basis"],
        json.dumps(row, ensure_ascii=False, sort_keys=True)
    ))
    connection.executemany("INSERT INTO current_owner_party VALUES (?,?)", [(row["id"], party_id) for party_id in row["owner_party_ids"]])
connection.executemany("INSERT INTO property_relation VALUES (?,?,?,?,?,?,?,?)", [
    (row["id"], row["from_type"], row["from_id"], row["to_property_id"], row["relation"], row.get("event_id"), row.get("certainty"),
     json.dumps(row, ensure_ascii=False, sort_keys=True)) for row in tables["property-relation"]
])
connection.executemany("INSERT INTO community_link VALUES (?,?,?,?,?,?,?)", [
    (row["id"], row["property_id"], row["person_id"], row["person_display_name"], row["relation"], int(row["legal_ownership"]), int(row["confirmed"])) for row in tables["community-link"]
])
connection.executemany("INSERT INTO manual_claim VALUES (?,?,?,?,?,?,?,?)", [
    (row["id"], row["property_id"], row["order"], row["text"], row["role"], int(row["normalized"]), row["normalized_entity_type"], row["normalized_entity_id"]) for row in tables["manual-claim"]
])
connection.executemany("INSERT INTO audit_finding VALUES (?,?,?,?,?,?,?)", [
    (row["id"], row["property_id"], row["status"], row["severity"], row["summary"], row["reviewed_on"], json.dumps(row, ensure_ascii=False, sort_keys=True)) for row in tables["audit-finding"]
])
connection.executemany("INSERT INTO rejected_claim VALUES (?,?,?,?,?,?,?)", [
    (row["id"], row["property_id"], row["claim"], row["reason"], row.get("locator"), row["reviewed_on"], json.dumps(row, ensure_ascii=False, sort_keys=True)) for row in tables["rejected-claim"]
])
connection.executemany("INSERT INTO evidence VALUES (:id,:subject_type,:subject_id,:source_id,:locator,:stance)", tables["evidence"])
connection.commit()
violations = connection.execute("PRAGMA foreign_key_check").fetchall()
if violations:
    raise RuntimeError(f"Foreign key-fel: {violations}")
connection.execute("VACUUM")
connection.close()
print(json.dumps({"sqlite": str(TARGET), "bytes": TARGET.stat().st_size, "tables": len(tables)}, ensure_ascii=False))
