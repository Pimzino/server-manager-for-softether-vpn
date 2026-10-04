#!/usr/bin/env python3
"""Generate the SoftEther JSON-RPC API catalog.

Sources:
  * vpnrpc.ts (official generated TypeScript stubs) for method docs, types and enums
  * src/Cedar/Admin.c for the authoritative list of RPC names the server dispatches
  * tools/catalog-extra.json for methods present in Admin.c but missing from the stubs

Output: packages/api-catalog/catalog.json
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SE = ROOT / "vendor" / "SoftEtherVPN"
TS = SE / "developer_tools/vpnserver-jsonrpc-clients/vpnserver-jsonrpc-client-typescript/vpnrpc.ts"
ADMIN_C = SE / "src/Cedar/Admin.c"
EXTRA = ROOT / "tools" / "catalog-extra.json"
OUT = ROOT / "packages" / "api-catalog" / "catalog.json"

src = TS.read_text(encoding="utf-8-sig")

# --- methods ---
method_re = re.compile(
    r"/\*\*\s*(?P<doc>.*?)\s*\*/\s*public (?P<name>[A-Za-z0-9]+) = \((?:in_param: (?P<in>[A-Za-z0-9]+))?\): Promise<(?P<out>[A-Za-z0-9]+)> =>",
    re.S,
)
methods = {}
for m in method_re.finditer(src):
    methods[m["name"]] = {
        "name": m["name"],
        "doc": " ".join(m["doc"].split()),
        "input": m["in"],
        "output": m["out"],
    }

# --- enums ---
enums = {}
enum_re = re.compile(r"(?:/\*\*\s*(?P<doc>.*?)\s*\*/\s*)?export enum (?P<name>\w+)\s*\{(?P<body>.*?)\n\}", re.S)
for m in enum_re.finditer(src):
    vals = []
    for vm in re.finditer(r"(?:/\*\*\s*(?P<doc>.*?)\s*\*/\s*)?(?P<k>\w+)\s*=\s*(?P<v>-?\d+)\s*,", m["body"], re.S):
        vals.append({"key": vm["k"], "value": int(vm["v"]), "doc": " ".join((vm["doc"] or "").split())})
    enums[m["name"]] = {"name": m["name"], "values": vals}

# --- classes ---
types = {}
class_re = re.compile(r"(?:/\*\*\s*(?P<doc>[^*]*?(?:\*(?!/)[^*]*?)*)\s*\*/\s*)?export class (?P<name>Vpn\w+)\s*\{(?P<body>.*?)\n\}", re.S)
field_re = re.compile(r"/\*\*\s*(?P<doc>(?:(?!\*/).)*?)\s*\*/\s*public (?:(?P<f>\w+)|\[\"(?P<qf>[^\"]+)\"\])(?P<opt>\?)?: (?P<t>[\w\[\]]+)\s*=", re.S)
for m in class_re.finditer(src):
    if m["name"] == "VpnServerRpc":
        continue
    fields = []
    for fm in field_re.finditer(m["body"]):
        t = fm["t"]
        f = fm["f"] or fm["qf"]
        is_array = t.endswith("[]")
        base = t[:-2] if is_array else t
        suffix = f.rsplit("_", 1)[-1] if "_" in f else ""
        kind = {
            "str": "string", "utf": "string", "u32": "number", "u64": "number",
            "bool": "boolean", "ip": "ip", "dt": "datetime", "bin": "binary",
        }.get(suffix)
        if is_array:
            kind = "array"
        elif base in enums:
            kind = "enum"
        elif kind is None:
            kind = "object" if base.startswith("Vpn") else base
        fld = {"name": f, "kind": kind, "doc": " ".join(fm["doc"].split())}
        if kind == "array":
            fld["items"] = base
        if kind == "enum":
            fld["enum"] = base
        if kind == "object":
            fld["type"] = base
        fields.append(fld)
    types[m["name"]] = {"name": m["name"], "doc": " ".join((m["doc"] or "").split()), "fields": fields}

# --- fixups: stub errors found by comparing with a live 5.x server ---
TRAFFIC = re.compile(r"^(Ex\.)?(Recv|Send)\.(Broadcast|Unicast)(Bytes|Count)_u64$")
for t in types.values():
    for f in t["fields"]:
        m = TRAFFIC.match(f["name"])
        if m:  # the stubs' docs for these counters are shifted by one field
            f["doc"] = f"{m[3]} {'bytes' if m[4] == 'Bytes' else 'packets'} ({'received' if m[2] == 'Recv' else 'sent'})"
        if f["name"].startswith("SecPol_"):  # server uses policy:* names for cascade policies
            f["name"] = "policy:" + f["name"][len("SecPol_"):]
        if f["name"] == "NumConnectionsEatablished_u32":
            f["name"] = "NumConnectionsEstablished_u32"

for t in types.values():  # renames can collide with existing names
    seen = set()
    t["fields"] = [f for f in t["fields"] if not (f["name"] in seen or seen.add(f["name"]))]

def add_field(type_name, field):
    t = types.get(type_name)
    if t and not any(x["name"] == field["name"] for x in t["fields"]):
        t["fields"].append(field)

add_field("VpnRpcRadius", {"name": "RadiusRetryTimeout_u32", "kind": "number", "doc": "RADIUS retry timeout in milliseconds (default 15000)"})
add_field("VpnInternetSetting", {"name": "CustomHttpHeader_str", "kind": "string", "doc": "Custom HTTP header sent to the proxy server"})
add_field("VpnAccess", {"name": "UniqueId_u32", "kind": "number", "doc": "Unique id of the rule (assigned by the server)"})
add_field("VpnRpcSetUser", {"name": "HashedKey_bin", "kind": "binary", "doc": "SHA-0 password hash (password-equivalent). Returned to admins only; if non-zero it takes precedence over Auth_Password_str."})
add_field("VpnRpcSetUser", {"name": "NtLmSecureHash_bin", "kind": "binary", "doc": "NTLM password hash (password-equivalent). Returned to admins only."})
for tn in ("VpnRpcCreateHub",):
    add_field(tn, {"name": "HashedPassword_bin", "kind": "binary", "doc": "Hub admin password hash (admins only). Leave empty to keep."})
    add_field(tn, {"name": "SecurePassword_bin", "kind": "binary", "doc": "Hub admin secure password hash (admins only). Leave empty to keep."})

if "Test" in methods:  # the stub's doc for Test swallowed generated source code
    methods["Test"]["doc"] = "Test RPC function. Input any integer value to the IntValue_u32 field. Then the server will convert the integer to the string, and return the string in the StrValue_str field."

# --- server-declared list ---
server_names = sorted(set(re.findall(r'DECLARE_RPC(?:_EX)?\("(\w+)"', ADMIN_C.read_text(errors="ignore"))))

extra = json.loads(EXTRA.read_text()) if EXTRA.exists() else {"methods": {}, "types": {}}
for name, t in extra.get("types", {}).items():
    types.setdefault(name, t)
for name, meth in extra.get("methods", {}).items():
    methods.setdefault(name, meth)

for name, meth in methods.items():
    meth["serverDeclared"] = name in server_names

missing = [n for n in server_names if n not in methods]
if missing:
    print("WARNING: server methods without catalog entry:", missing, file=sys.stderr)

# unresolved type references
for meth in methods.values():
    for k in ("input", "output"):
        if meth.get(k) and meth[k] not in types:
            print(f"WARNING: {meth['name']}.{k} type {meth[k]} not found", file=sys.stderr)

errors = {}
for line in (SE / "src/bin/hamcore/strtable_en.stb").read_text(encoding="utf-8", errors="ignore").splitlines():
    em = re.match(r"^ERR_(\d+)\s+(.*)$", line)
    if em:
        errors[int(em[1])] = em[2].strip().replace("\\r", "").replace("\\n", " ")

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({
    "generatedFrom": {"stubs": str(TS.relative_to(ROOT)), "server": str(ADMIN_C.relative_to(ROOT))},
    "serverMethods": server_names,
    "methods": methods,
    "types": types,
    "enums": enums,
    "errors": errors,
}, indent=1))
print(f"methods={len(methods)} types={len(types)} enums={len(enums)} server={len(server_names)} missing={len(missing)}")
