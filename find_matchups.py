#!/usr/bin/env python3
"""Busca replays por matchup y/o nombres usando metadata de .slp."""
import os
import sys
import struct
import ubjson

CHAR_NAMES = {
    0: "CAPTAIN_FALCON", 1: "DONKEY_KONG", 2: "FOX", 3: "GAME_AND_WATCH",
    4: "KIRBY", 5: "BOWSER", 6: "LINK", 7: "LUIGI", 8: "MARIO", 9: "MARTH",
    10: "MEWTWO", 11: "NESS", 12: "PEACH", 13: "PIKACHU", 14: "ICE_CLIMBERS",
    15: "JIGGLYPUFF", 16: "SAMUS", 17: "YOSHI", 18: "ZELDA", 19: "SHEIK",
    20: "FALCO", 21: "YOUNG_LINK", 22: "DR_MARIO", 23: "ROY", 24: "PICHU",
    25: "GANONDORF",
}

def internal_to_external(i):
    if i == 0x07:
        return 0x13
    if i == 0x13:
        return 0x12
    return i

def read_metadata(path):
    try:
        with open(path, "rb") as f:
            data = f.read()
    except Exception:
        return None
    if len(data) < 16 or data[0] != ord("{"):
        return None
    raw_data_position = 15
    raw_data_length = struct.unpack(">I", data[11:15])[0]
    if raw_data_length <= 0 or raw_data_length > len(data):
        return None
    metadata_position = raw_data_position + raw_data_length + 10
    metadata_length = len(data) - metadata_position - 1
    if metadata_length <= 0:
        return None
    try:
        return ubjson.loadb(data[metadata_position : metadata_position + metadata_length])
    except Exception:
        return None

def main(root_dir, name_filter=None, char_a=None, char_b=None):
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            if not fname.endswith(".slp"):
                continue
            path = os.path.join(dirpath, fname)
            metadata = read_metadata(path)
            if not metadata or "players" not in metadata:
                continue
            players = metadata["players"]
            if len(players) < 2:
                continue
            infos = []
            for idx, p in players.items():
                code = p.get("names", {}).get("code", "")
                netplay = p.get("names", {}).get("netplay", "")
                usage = p.get("characterUsage", {})
                chars = {internal_to_external(int(k)) for k in usage.keys()}
                infos.append({"code": code, "netplay": netplay, "chars": chars})

            names = " ".join([f"{i['code']}/{i['netplay']}" for i in infos])
            chars_set = set()
            for i in infos:
                chars_set.update(i["chars"])

            if name_filter and name_filter.lower() not in names.lower():
                continue

            if char_a is not None and char_b is not None:
                if char_a not in chars_set or char_b not in chars_set:
                    continue

            char_strs = []
            for i in infos:
                names_chars = ",".join(CHAR_NAMES.get(c, str(c)) for c in i["chars"])
                char_strs.append(f"{i['code']}/{i['netplay']}({names_chars})")
            print(f"{path}: {' vs '.join(char_strs)}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Uso: {sys.argv[0]} /ruta/a/Slippi [filtro_nombre] [char_a] [char_b]")
        sys.exit(1)
    root = sys.argv[1]
    name_filter = sys.argv[2] if len(sys.argv) > 2 else None
    char_a = int(sys.argv[3]) if len(sys.argv) > 3 else None
    char_b = int(sys.argv[4]) if len(sys.argv) > 4 else None
    main(root, name_filter, char_a, char_b)
