#!/usr/bin/env python3
# hidden_cam_scanner.py  |  Techography (YouTube @aziziurrahaman)
# Written by Claude from the exact prompt in the video, then tested.
# Tested: Linux lab network (real run); Windows + macOS ping/ARP parsing tested
# with sample command output. Only change from Claude's output: the MAC-maker
# list below was swapped for prefixes verified in the official IEEE registry.
# Python 3 standard library only. Run:  py hidden_cam_scanner.py  (Windows)
#                                      python3 hidden_cam_scanner.py  (Mac/Linux)
# Only scan networks you are allowed to use. A flag is NOT proof of a camera.
"""
hidden_cam_scanner.py

A standard-library-only network scanner meant to help spot *possible*
hidden IP cameras on a local Wi-Fi network (hotel room, Airbnb, etc).

It is a heuristic tool, not a forensic one. A "POSSIBLE CAMERA" flag is
NOT proof of a hidden camera - it just means the device looks like common
camera/DVR hardware and deserves a closer physical look.

Usage:
    python3 hidden_cam_scanner.py
    python3 hidden_cam_scanner.py 10.0.0.0/24
"""

import sys
import os
import re
import socket
import platform
import subprocess
import ipaddress
import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

# --------------------------------------------------------------------------
# Enable ANSI colors on Windows 10+ consoles / PowerShell
# --------------------------------------------------------------------------
if platform.system() == "Windows":
    try:
        os.system("")  # harmless trick that turns on VT100 processing
    except Exception:
        pass

RED = "\033[91m"
YELLOW = "\033[93m"
GREEN = "\033[92m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

# --------------------------------------------------------------------------
# Known OUI (MAC) prefixes used by common camera / DVR / cheap spy-cam chips.
# NOT exhaustive. Router vendors intentionally excluded.
# --------------------------------------------------------------------------
# Camera-maker MAC prefixes, each one checked against the official IEEE OUI
# registry (standards-oui.ieee.org) on 23 Oct 2026. Router brands excluded.
_VERIFIED_PREFIXES = {
    "Hikvision": (
        "00BC99 040312 04EECD 083BC1 085411 08A189 08CC81 0C75D2 1012FB 1868CB "
        "188025 240F9B 2428FD 2432AE 244845 24B105 2857BE 2CA59C 340962 3C1BF8 "
        "40ACBF 40B570 4419B6 4447CC 44A642 48785B 4C1F86 4C62DF 4CBD8F 4CF5DC "
        "50E538 548C81 54C415 5803FB 5850ED 5C345B 64DB8B 686DBC 743FC2 80489F "
        "807C62 80BEAF 80F5AE 849459 849A40 88DE39 8C22D2 8CE748 94E1AC 988B0A "
        "989DE5 98DF82 98F112 A0FF0C A41437 A42902 A44BD9 A4A459 A4D5C2 ACB92F "
        "ACCB51 B0FF0D B4A382 BC2978 BC5E33 BC9B5E BCAD28 BCBAC2 C0517E C056E3 "
        "C06DED C42F90 C8A702 CC13F3 D4E853 DC07F8 DCD26A E0BAAD E0CA3C E0DF13 "
        "E4D58B E8A0ED ECA971 ECC89C F84DFC FC9FFD "
    ),
    "Dahua": (
        "08EDED 14A78B 202C05 24526A 30DDAA 38AF29 3CE36B 3CEF8C 407AA4 4C11BF "
        "4C99E8 5CF51A 64FD29 6C1C71 74C929 8CE9B4 9002A9 98F9CC 9C1463 A0BD1D "
        "A8CA87 B44C3B BC325F C0395A C4AAC4 D4430E E02EFE E0508B E4246C F4B1C2 "
        "F8CE07 FC5F49 FCB69D "
    ),
    "Ezviz": (
        "0CA64C 20BBBC 34C6DD 38F25D 54D60D 588FCF 64244D 64F2FB 78A6A0 78C1AE "
        "94EC13 AC1C26 EC97E0 F47018 FC2422 "
    ),
    "Uniview": (
        "14BA88 48EA63 6CF17E 88263F C47905 "
    ),
    "Reolink": (
        "EC71DB "
    ),
    "Wyze": (
        "2CAA8E 7C78B2 80482C D03F27 F0C88B "
    ),
    "Amcrest": (
        "00651E 9C8ECD A06032 "
    ),
    "Tuya (smart-home chip)": (
        "00337A 105A17 10D561 1869D8 18DE50 1C90FF 20F1B2 2CB471 30487D 381F8D "
        "382CE5 38A5C9 3C0B59 4CA919 508A06 508BB9 68572D 708976 7CF666 80647C "
        "84E342 A09208 A88055 A8DDBC ACF878 B8060D BC351E C0F853 C482E1 CC8CBF "
        "D032E7 D082E8 D082EB D4A651 D81F12 D8C80C D8D668 D8FC92 E4AEE4 F8172D "
        "FC3CD7 FC671F "
    ),
    "Espressif (ESP32 chip)": (
        "004B12 007007 00FB4A 048308 04B247 083A8D 083AF2 089272 08A6F7 08AD0A "
        "08B61F 08D1F9 08F9E0 0C4EA0 0C8B95 0CB815 0CDC7E 10003B 10061C 1020BA "
        "1051DB 10521C 1091A8 1097BD 10A85B 10B41D 10BDA3 140808 142B2F 14335C "
        "146393 14C19F 188B0E 18FE34 1C2904 1C6465 1C6920 1C8B84 1C8F57 1C9DC2 "
        "1CC3AB 1CDBD4 1CE4CB 202565 2043A8 20500D 206EF1 209BA9 20D5C2 20E5A4 "
        "20E7C8 240AC4 244CAB 24587C 2462AB 246F28 24A160 24B2DE 24D7EB 24DCC3 "
        "24EC4A 2805A5 28372F 28562F 288485 2C3AE8 2CBCBB 2CF432 3030F9 3076F5 "
        "308398 30AEA4 30C6F7 30C922 30EDA0 345F45 348518 34865D 349454 34987A "
        "34AB95 34B472 34B7DA 34C934 34CDB0 38182B 383E51 3844BE 3C0D0D 3C0F02 "
        "3C6105 3C71BF 3C8427 3C8A1F 3CDC75 3CE255 3CE90E 4022D8 402BD6 404CCA "
        "409151 40F520 441793 441BF6 441D64 447B30 44B176 44BD8D 4827E2 4831B7 "
        "483FDA 485519 489D31 48AFF3 48CA43 48E729 48F6EE 4C11AE 4C7525 4C8421 "
        "4CC382 4CEBD6 500291 50787D 5416A5 543204 5443B2 545AA6 549DEA 582ABD "
        "582BD3 588C81 58B145 58BF25 58CF79 58E6C5 5C013B 5CCF7F 600194 6055F9 "
        "648914 64B708 64E833 680947 6825DD 686725 689DD2 68B6B3 68C63A 68EE8F "
        "68FE71 6C2FA0 6C3DD8 6CB456 6CC4AF 6CC840 6CE210 70039F 70041D 704BCA "
        "70AF09 70B8F6 744DBD 748927 781C3C 782184 78421C 78E36D 78EE4C 7C0C5F "
        "7C2C67 7C4FAD 7C7398 7C87CE 7C9EBD 7CD544 7CDFA1 7CE8B1 80456B 8053E0 "
        "80646F 806599 807D3A 80B54E 80F1B2 80F3DA 840D8E 841FE8 84C7BB 84CCA8 "
        "84F3EB 84F703 84FCE6 8813BF 8856A6 885721 88F155 8C4598 8C4B14 8C4F00 "
        "8C8C29 8C94DF 8CAAB5 8CBFEA 8CCE4E 8CFD49 901506 90380C 90649B 907069 "
        "9097D5 90B339 90DA72 90E5B1 943CC6 9451DC 9454C5 94A990 94B555 94B97E "
        "94E686 983DAE 9888E0 98A316 98C377 98CDAC 98F4AB 9C139E 9C96D5 9C9C1F "
        "9C9E6E 9CCC01 A020A6 A0764E A085E3 A0A3B3 A0B765 A0DD6C A0F262 A47B9D "
        "A4CB8F A4CF12 A4E57C A4E972 A4F00F A8032A A842E3 A84674 A848FA A8FD07 "
        "AC0BFB AC1518 AC276E AC67B2 ACA26A ACA704 ACD074 ACEBE6 B03FD3 B08184 "
        "B0A604 B0A732 B0B21C B0CBD8 B43A45 B48A0A B4A64A B4BFE9 B4E62D B4FEB5 "
        "B81F3F B87B4D B8BB11 B8D61A B8F009 B8F862 BC1926 BCDDC2 BCFF4D C049EF "
        "C04E30 C05D89 C0CDD6 C44F33 C45BBE C49E7E C4D8D5 C4DD57 C4DEE2 C82B96 "
        "C82E18 C88541 C88A7B C8C9A3 C8DA29 C8EA71 C8ED8B C8F09E CC50E3 CC68C7 "
        "CC7B5C CC7E1F CC8DA2 CCBA97 CCDBA7 CCE732 D09AAF D0CF13 D0EF76 D40592 "
        "D48AFC D48C49 D4D4DA D4E9F4 D4F98D D8132A D83BDA D885AC D8A01D D8BC38 "
        "D8BFC0 D8F15B DC0675 DC0A69 DC1ED5 DC4F22 DC5475 DC55B1 DCB4D9 DCDA0C "
        "E05A1B E072A1 E08CFE E09806 E0E2E6 E465B8 E4B063 E4B323 E80690 E831CD "
        "E83DC1 E868E7 E86BEA E89F6D E8DB84 E8EDBD E8F60A EC6260 EC64C9 EC94CB "
        "ECC9FF ECD61B ECDA3B ECE334 ECFABC F008D1 F0161D F024F9 F09E9E F0F5BD "
        "F412FA F42DC9 F4650B F4CFA2 F80C4E F843EE F85B1B F8B3B7 FC012C FCB467 "
        "FCE8C0 FCF5C4 "
    ),
    "Xiaomi (also phones/smart home)": (
        "009EC8 00C30A 00EC0A 04106B 046761 047A0B 04AE47 04B167 04C807 04CF8C "
        "04D13A 04E598 081C6E 082525 08B339 0C07DF 0C1DAF 0C9838 0CC6FD 0CEDC8 "
        "0CF346 102AB3 103F44 10C197 1449D4 14907A 14993E 14D881 14F65A 1801F1 "
        "185936 188740 18F0E4 1C2575 1C2AB0 1C8BEF 1CCCD6 1CEAAC 2025CC 203462 "
        "2034FB 203B34 2047DA 2072A9 2082C0 209952 20A60C 20F478 241145 246477 "
        "24CF24 24D337 28167F 285923 286C07 28D127 28E31F 2C0B97 2C0DCF 2C195C "
        "2CD066 2CFE4F 3007EB 3050CE 341CF0 343932 3480B3 34B98D 34CE00 34F015 "
        "34FA1C 38A4ED 38C1ED 38C6BD 38E60A 3C135A 3C2CA6 3C3824 3C7F6E 3CAFB7 "
        "3CBD3E 3CCD57 400877 40313C 44237C 444A37 44579F 447147 44BDC8 44CBAD "
        "44DF65 44E213 44F770 482CA0 488759 48FDA3 4C0220 4C49E3 4C55B2 4C6371 "
        "4C8E19 4CC64C 4CE0DB 4CE20F 4CF202 503DC6 504F3B 50642B 508811 508E49 "
        "508F4C 50926A 509839 50A009 50D2F5 50DAD6 50EC50 50FE39 5448E6 582059 "
        "584498 58B623 58EA1F 5C0214 5C4071 5CD06E 5CE50C 606EE8 60AB67 60F723 "
        "640980 646306 64644A 6490C1 649E31 64A200 64B473 64CC2E 64DDE9 684DB6 "
        "68ABBC 68B8BB 68C44C 68DFDD 6C0699 6C0DC4 6C483F 6CF784 70217F 703A51 "
        "705FA3 709751 70BBE9 741575 742344 743822 7451BA 74F2FA 7802F8 7811DC "
        "785333 789987 78D840 7C035E 7C03AB 7C0CF1 7C1DD9 7C2ADB 7C49EB 7CA449 "
        "7CC294 7CD661 7CFD6B 8035C1 808F97 80AD16 80E63C 844693 84AEDE 882F92 "
        "884604 8852EB 886C60 88B951 88C397 8C53C3 8C5AF8 8C7A3D 8CAACE 8CBEBE "
        "8CD0B2 8CD9D6 8CDEF9 902AEE 9078B2 90FB5D 941700 94626D 947BAE 9487E0 "
        "948B93 94D331 9812E0 98171A 987552 98E081 98EE94 98F621 98FAE3 9C28F7 "
        "9C2EA1 9C5A81 9C99A0 9C9D7E 9C9ED5 9CBCF0 A086C6 A439B3 A44519 A44BD5 "
        "A45046 A45590 A4A930 A4BA70 A4C3BE A4C788 A4CCB3 A4E287 A4FF9F A82BD5 "
        "A86A86 A89CED AC1E9E AC8C46 ACC1EE ACE4D8 ACF7F3 B00BE2 B09C63 B0E235 "
        "B405A1 B460ED B47E9F B4C4FC B83BCC B850D8 B852E0 B85384 B894E7 B8EA98 "
        "BC6193 BC6AD1 BC7FA4 C01693 C05B44 C40BCB C46940 C46AB7 C4710F C493BB "
        "C82832 C83DDC C85CCC C8BF4C CC033D CC4210 CC4D75 CCB5D1 CCD843 CCDA20 "
        "CCEB5E D09C7A D0AE05 D0C1BF D0CEC0 D41761 D43538 D4438A D4532A D45EEC "
        "D4970B D4A365 D4DA21 D4F0EA D832E3 D86375 D893D4 D8B053 D8CE3A D8E374 "
        "D8EDA8 DC6AE7 DCB72E DCED83 E01F88 E06267 E0806B E0B655 E0CCF8 E0DCFF "
        "E41B43 E44519 E446DA E484D3 E4AAE4 E4BCAA E4D398 E4DB6D E4FE43 E84A54 "
        "E85A8B E85FB4 E87EEF E88843 E89847 E8BA17 E8F791 EC1055 EC30B3 EC4118 "
        "EC4D3E ECD09F ECFA5C F06C5D F0B429 F41A9C F4308B F460E2 F48B32 F4F5DB "
        "F843EF F8710C F88306 F8A45F F8AB82 FC0296 FC1999 FC4345 FC5B8C FC64BA "
        "FCA9F5 FCC17D FCD908 "
    ),
}
VENDOR_PREFIXES = {}
for _maker, _blob in _VERIFIED_PREFIXES.items():
    for _p in _blob.split():
        VENDOR_PREFIXES[_p[0:2] + ":" + _p[2:4] + ":" + _p[4:6]] = _maker

CAMERA_PORTS = {554, 8554}          # RTSP video streams
DVR_PORTS = {8000, 8899, 34567, 37777}  # DVR / camera control apps
WEB_PORTS = {80, 8080}              # normal, used alone means little
ALL_PORTS = sorted(CAMERA_PORTS | DVR_PORTS | WEB_PORTS)

BROADCAST_MAC = "FF:FF:FF:FF:FF:FF"
ZERO_MAC = "00:00:00:00:00:00"


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def get_local_ip():
    """Find local IP without needing admin rights or external packages."""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"
    finally:
        if s:
            s.close()


def normalize_mac(raw):
    """Turn any MAC-ish string into AA:BB:CC:DD:EE:FF uppercase, or None."""
    if not raw:
        return None
    parts = re.split(r"[:\-]", raw.strip())
    if len(parts) != 6:
        return None
    try:
        norm = []
        for p in parts:
            p = p.strip()
            if not re.fullmatch(r"[0-9A-Fa-f]{1,2}", p):
                return None
            norm.append(p.zfill(2).upper())
        return ":".join(norm)
    except Exception:
        return None


def vendor_lookup(mac):
    if not mac or mac in (ZERO_MAC, BROADCAST_MAC):
        return None
    prefix = mac.upper()[0:8]
    return VENDOR_PREFIXES.get(prefix)


# --------------------------------------------------------------------------
# Ping sweep
# --------------------------------------------------------------------------
def ping_once(ip, system):
    try:
        if system == "Windows":
            cmd = ["ping", "-n", "1", "-w", "1000", str(ip)]
        elif system == "Darwin":
            cmd = ["ping", "-c", "1", "-W", "1000", str(ip)]
        else:
            cmd = ["ping", "-c", "1", "-W", "1", str(ip)]
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=2,
        )
        out = proc.stdout.decode(errors="ignore") + proc.stderr.decode(errors="ignore")
        return "ttl" in out.lower()
    except Exception:
        return False


def ping_sweep(hosts, system, max_workers=100):
    alive = set()
    try:
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futures = {ex.submit(ping_once, ip, system): ip for ip in hosts}
            for fut in as_completed(futures):
                ip = futures[fut]
                try:
                    if fut.result():
                        alive.add(str(ip))
                except Exception:
                    pass
    except Exception:
        pass
    return alive


# --------------------------------------------------------------------------
# ARP table retrieval (per OS)
# --------------------------------------------------------------------------
def arp_table_linux():
    table = {}
    try:
        with open("/proc/net/arp", "r") as f:
            lines = f.readlines()[1:]
        for line in lines:
            parts = line.split()
            if len(parts) >= 4:
                ip, mac = parts[0], parts[3]
                mac_n = normalize_mac(mac)
                if mac_n and mac_n != ZERO_MAC:
                    table[ip] = mac_n
    except Exception:
        pass

    if not table:
        try:
            proc = subprocess.run(
                ["ip", "neigh"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5
            )
            out = proc.stdout.decode(errors="ignore")
            for line in out.splitlines():
                if "FAILED" in line or "INCOMPLETE" in line:
                    continue
                m = re.match(r"(\d+\.\d+\.\d+\.\d+).*lladdr\s+([0-9A-Fa-f:]+)", line)
                if m:
                    mac_n = normalize_mac(m.group(2))
                    if mac_n and mac_n != ZERO_MAC:
                        table[m.group(1)] = mac_n
        except Exception:
            pass
    return table


def arp_table_windows():
    table = {}
    try:
        proc = subprocess.run(
            ["arp", "-a"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5
        )
        out = proc.stdout.decode(errors="ignore")
        for line in out.splitlines():
            m = re.match(
                r"\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5})",
                line,
            )
            if m:
                ip, mac = m.groups()
                mac_n = normalize_mac(mac)
                if mac_n and mac_n != BROADCAST_MAC and mac_n != ZERO_MAC:
                    table[ip] = mac_n
    except Exception:
        pass
    return table


def arp_table_macos():
    table = {}
    try:
        proc = subprocess.run(
            ["arp", "-an"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5
        )
        out = proc.stdout.decode(errors="ignore")
        for line in out.splitlines():
            m = re.match(
                r".*\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9A-Fa-f:]+)", line
            )
            if m:
                ip, mac = m.groups()
                if "incomplete" in mac.lower():
                    continue
                mac_n = normalize_mac(mac)
                if mac_n and mac_n != BROADCAST_MAC and mac_n != ZERO_MAC:
                    table[ip] = mac_n
    except Exception:
        pass
    return table


def get_arp_table(system):
    try:
        if system == "Windows":
            return arp_table_windows()
        elif system == "Darwin":
            return arp_table_macos()
        else:
            return arp_table_linux()
    except Exception:
        return {}


# --------------------------------------------------------------------------
# Port scanning
# --------------------------------------------------------------------------
def scan_port(ip, port, timeout=0.5):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            result = s.connect_ex((str(ip), port))
            return result == 0
    except Exception:
        return False


def scan_ports_for_host(ip, ports):
    open_ports = []
    try:
        with ThreadPoolExecutor(max_workers=len(ports)) as ex:
            futures = {ex.submit(scan_port, ip, p): p for p in ports}
            for fut in as_completed(futures):
                p = futures[fut]
                try:
                    if fut.result():
                        open_ports.append(p)
                except Exception:
                    pass
    except Exception:
        pass
    return sorted(open_ports)


# --------------------------------------------------------------------------
# Verdict logic
# --------------------------------------------------------------------------
def make_verdict(maker, open_ports):
    open_set = set(open_ports)

    if open_set & CAMERA_PORTS:
        return (
            "RED",
            "POSSIBLE CAMERA",
            f"RTSP video port open ({sorted(open_set & CAMERA_PORTS)})",
        )

    if maker and (open_set & (CAMERA_PORTS | DVR_PORTS)):
        return (
            "RED",
            "POSSIBLE CAMERA",
            f"{maker} vendor MAC + camera/DVR port open ({sorted(open_set & (CAMERA_PORTS | DVR_PORTS))})",
        )

    if maker:
        return (
            "YELLOW",
            "CHECK",
            f"MAC matches known camera vendor ({maker}), no camera port confirmed",
        )

    if open_set & DVR_PORTS:
        return (
            "YELLOW",
            "CHECK",
            f"DVR/camera-app port open ({sorted(open_set & DVR_PORTS)}), vendor unknown",
        )

    if open_set:
        return ("GREEN", "OK", f"Only normal/web ports open ({sorted(open_set)})")

    return ("GREEN", "OK", "No open camera-related ports, no vendor match")


def colorize(level, text):
    color = {"RED": RED, "YELLOW": YELLOW, "GREEN": GREEN}.get(level, "")
    return f"{color}{text}{RESET}"


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def build_host_list(network_arg, local_ip):
    try:
        if network_arg:
            net = ipaddress.ip_network(network_arg, strict=False)
        else:
            iface = ipaddress.ip_interface(f"{local_ip}/24")
            net = iface.network
        hosts = list(net.hosts())
        return net, hosts
    except Exception as e:
        print(f"{RED}Invalid network '{network_arg}': {e}{RESET}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Scan local Wi-Fi network for possible hidden cameras (stdlib only)."
    )
    parser.add_argument(
        "network",
        nargs="?",
        default=None,
        help="Network to scan in CIDR form, e.g. 10.0.0.0/24 (default: auto-detect /24)",
    )
    args = parser.parse_args()

    system = platform.system()
    start_time = time.time()

    local_ip = get_local_ip()
    net, hosts = build_host_list(args.network, local_ip)

    print(f"{BOLD}{CYAN}Hidden Camera Scanner{RESET}")
    print(f"Local IP      : {local_ip}")
    print(f"Target network: {net}")
    print(f"Hosts to probe: {len(hosts)}")
    print("Scanning... this may take up to a minute.\n")

    # 1. Ping sweep
    try:
        alive_ips = ping_sweep(hosts, system, max_workers=100)
    except Exception as e:
        print(f"{YELLOW}Ping sweep failed: {e}{RESET}")
        alive_ips = set()

    # 2. ARP table (adds devices that didn't answer ping but are in cache)
    try:
        arp_table = get_arp_table(system)
    except Exception as e:
        print(f"{YELLOW}ARP lookup failed: {e}{RESET}")
        arp_table = {}

    all_ips = set(alive_ips) | set(arp_table.keys())

    # keep only IPs inside requested network if possible
    filtered_ips = []
    for ip in all_ips:
        try:
            if ipaddress.ip_address(ip) in net:
                filtered_ips.append(ip)
        except Exception:
            continue

    if not filtered_ips:
        print(f"{YELLOW}No devices found. Try again or check network permissions.{RESET}")
        return

    # 3. Port scan every device found
    results = []
    try:
        with ThreadPoolExecutor(max_workers=25) as ex:
            future_map = {
                ex.submit(scan_ports_for_host, ip, ALL_PORTS): ip for ip in filtered_ips
            }
            for fut in as_completed(future_map):
                ip = future_map[fut]
                try:
                    open_ports = fut.result()
                except Exception:
                    open_ports = []
                mac = arp_table.get(ip, "N/A")
                maker = vendor_lookup(mac) if mac != "N/A" else None
                level, label, reason = make_verdict(maker, open_ports)
                results.append(
                    {
                        "ip": ip,
                        "mac": mac,
                        "maker": maker or "-",
                        "ports": open_ports,
                        "level": level,
                        "label": label,
                        "reason": reason,
                    }
                )
    except Exception as e:
        print(f"{YELLOW}Port scanning failed: {e}{RESET}")

    # sort results: by IP numerically
    def ip_key(r):
        try:
            return ipaddress.ip_address(r["ip"])
        except Exception:
            return ipaddress.ip_address("0.0.0.0")

    results.sort(key=ip_key)

    # --------------------------------------------------------------------
    # Print table
    # --------------------------------------------------------------------
    col_ip = 16
    col_mac = 19
    col_maker = 26
    col_ports = 22
    col_verdict = 18

    header = (
        f"{BOLD}{'IP':<{col_ip}}{'MAC':<{col_mac}}{'Maker':<{col_maker}}"
        f"{'Open Ports':<{col_ports}}{'Verdict':<{col_verdict}}{RESET}"
    )
    print(header)
    print("-" * (col_ip + col_mac + col_maker + col_ports + col_verdict))

    suspects = 0
    checks = 0

    for r in results:
        ports_str = ",".join(str(p) for p in r["ports"]) if r["ports"] else "-"
        verdict_str = colorize(r["level"], r["label"])
        line = (
            f"{r['ip']:<{col_ip}}"
            f"{r['mac']:<{col_mac}}"
            f"{r['maker']:<{col_maker}}"
            f"{ports_str:<{col_ports}}"
            f"{verdict_str}"
        )
        print(line)
        print(f"   {colorize(r['level'], 'reason:')} {r['reason']}")

        if r["level"] == "RED":
            suspects += 1
        elif r["level"] == "YELLOW":
            checks += 1

    elapsed = time.time() - start_time

    # --------------------------------------------------------------------
    # Summary
    # --------------------------------------------------------------------
    print("\n" + "=" * 60)
    print(f"{BOLD}Summary{RESET}")
    print(f"Devices found     : {len(results)}")
    print(f"{RED}Possible cameras  : {suspects}{RESET}")
    print(f"{YELLOW}Worth checking    : {checks}{RESET}")
    print(f"Time elapsed      : {elapsed:.1f}s")
    print("-" * 60)
    print(
        f"{YELLOW}Reminder: A RED/YELLOW flag is NOT proof of a hidden camera.{RESET}\n"
        "It only means the MAC vendor or open ports match common camera/DVR\n"
        "hardware. Always physically inspect suspicious devices (smoke\n"
        "detectors, clocks, outlets, USB chargers, etc.) and use an IR\n"
        "flashlight / phone camera to check for lens glints as well."
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n{YELLOW}Scan interrupted by user.{RESET}")
    except Exception as e:
        print(f"{RED}Unexpected error: {e}{RESET}")
