#!/usr/bin/env python3
"""Busca replays por matchup usando el comando GAME_START (raw data)."""
import os
import sys
import struct

CHAR_NAMES = {
    0: "CAPTAIN_FALCON", 1: "DONKEY_KONG", 2: "FOX", 3: "GAME_AND_WATCH",
    4: "KIRBY", 5: "BOWSER", 6: "LINK", 7: "LUIGI", 8: "MARIO", 9: "MARTH",
    10: "MEWTWO", 11: "NESS", 12: "PEACH", 13: "PIKACHU", 14: "ICE_CLIMBERS",
    15: "JIGGLYPUFF", 16: "SAMUS", 17: "YOSHI", 18: "ZELDA", 19: "SHEIK",
    20: "FALCO", 21: "YOUNG_LINK", 22: "DR_MARIO", 23: "ROY", 24: "PICHU",
    25: "GANONDORF",
}

JIGGLYPUFF = 15
YOUNG_LINK = 21


def read_shift_jis(buf):
    try:
        return buf.split(b"\x00")[0].decode("shift_jis").strip()
    except Exception:
        return ""


def get_raw_data_position(data):
    if len(data) < 1:
        return None
    first = data[0]
    if first == 0x36:
        return 0
    if first == ord("{"):
        return 15
    return None


def get_message_sizes(data, position):
    if position == 0:
        return {0x36: 0x140, 0x37: 0x6, 0x38: 0x46, 0x39: 1}
    if data[position] != 0x35:
        return None
    payload_length = data[position + 1]
    sizes = {0x35: payload_length}
    ms_start = position + 2
    for i in range(0, payload_length - 1, 3):
        cmd = data[ms_start + i]
        size = (data[ms_start + i + 1] << 8) | data[ms_start + i + 2]
        sizes[cmd] = size
    return sizes


def parse_game_start(data, position, payload_size):
    payload = data[position + 1 : position + 1 + payload_size]
    if len(payload) < 0x221 + 4 * 0xA:
        return None
    players = []
    for i in range(4):
        offset = i * 0x24
        char_id = payload[0x65 + offset]
        ptype = payload[0x66 + offset]
        code_buf = payload[0x221 + i * 0xA : 0x221 + (i + 1) * 0xA]
        code = read_shift_jis(code_buf)
        display_buf = payload[0x1A5 + i * 0x1F : 0x1A5 + (i + 1) * 0x1F]
        display = read_shift_jis(display_buf)
        players.append({
            "playerIndex": i,
            "type": ptype,
            "characterId": char_id,
            "code": code,
            "display": display,
        })
    return players


def scan(root_dir):
    matches = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            if not fname.endswith(".slp"):
                continue
            path = os.path.join(dirpath, fname)
            try:
                with open(path, "rb") as f:
                    data = f.read(0x400)
            except Exception:
                continue
            raw_pos = get_raw_data_position(data)
            if raw_pos is None:
                continue
            sizes = get_message_sizes(data, raw_pos)
            if not sizes or 0x36 not in sizes:
                continue
            game_start_size = sizes[0x36]
            game_start_pos = raw_pos + 1 + sizes.get(0x35, 0) + 1
            # If for some reason the first command after MESSAGE_SIZES is not GAME_START, skip
            if data[game_start_pos] != 0x36:
                continue
            players = parse_game_start(data, game_start_pos, game_start_size)
            if not players:
                continue

            chars = {p["characterId"] for p in players if p["type"] != 3}  # 3 = absent?
            codes = " ".join(p["code"] for p in players)
            if JIGGLYPUFF in chars and YOUNG_LINK in chars and "SLIM#536" in codes:
                matches.append((path, players))
    return matches


def main(root_dir):
    matches = scan(root_dir)
    if not matches:
        print("No se encontro ningun replay Jigglypuff vs Young Link contra SLIM#536.")
        return
    print(f"Encontrados {len(matches)} replay(s):")
    for path, players in matches:
        print(f"{path}")
        for p in players:
            if p["type"] != 3:
                print(f"  P{p['playerIndex']} {p['code']}/{p['display']}: {CHAR_NAMES.get(p['characterId'], p['characterId'])}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Uso: {sys.argv[0]} /ruta/a/Slippi")
        sys.exit(1)
    main(sys.argv[1])
