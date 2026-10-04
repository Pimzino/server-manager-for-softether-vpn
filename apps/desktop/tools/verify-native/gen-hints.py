#!/usr/bin/env python3
"""Extract the JSON conversion hints of every SoftEther admin RPC result from the C source.

Why: the binary PACK that travels over the native admin RPC carries only element names, types and
values. The JSON-RPC API converts the *in-memory* PACK with PackToJson(), which also looks at hints
that the server's OutRpc*() functions set while building it (Mayaqua/Pack.c):
  JsonHint_IsBool (PackAddBool*), JsonHint_IsDateTime (PackAddTime64*), JsonHint_IsArray (PackAdd*Ex),
  JsonHint_IsIP (PackAddIp*), JsonHint_GroupName (PackSetCurrentJsonGroupName) and the list of group
  names (json_subitem_names, which yields "Group": [] even when no element was added).
Those hints are not serialized, so the native client re-creates them from this table in order to return
exactly the JSON the JSON-RPC API returns.

How: for each DECLARE_RPC(_EX) entry in Cedar/Admin.c, walk its out_rpc function and every helper it
calls with the PACK (inlining them, following PackSetCurrentJsonGroupName in textual order), and record
every PackAdd* call. Output: src/main/softether/pack.ts, between the GENERATED HINTS markers.

Usage: python3 apps/desktop/tools/verify-native/gen-hints.py [--check]
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SRC = ROOT / "vendor" / "SoftEtherVPN" / "src"
OUT = ROOT / "apps" / "desktop" / "src" / "main" / "softether" / "pack.ts"
BEGIN = "// BEGIN GENERATED HINTS (tools/verify-native/gen-hints.py; do not edit by hand)"
END = "// END GENERATED HINTS"


def strip_comments(s: str) -> str:
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < n and s[j] != c:
                j += 2 if s[j] == "\\" else 1
            out.append(s[i:j + 1]); i = j + 1
        elif s.startswith("//", i):
            j = s.find("\n", i); i = n if j < 0 else j
        elif s.startswith("/*", i):
            j = s.find("*/", i + 2); out.append(" "); i = n if j < 0 else j + 2
        else:
            out.append(c); i += 1
    return "".join(out)


def strip_disabled(s: str) -> str:
    """Drop `#if 0 ... #endif` blocks (textual, non-nested enough for this code base)."""
    return re.sub(r"^#if\s+0\b.*?^#endif\b[^\n]*", "", s, flags=re.S | re.M)


def match_paren(s: str, i: int) -> int:
    """s[i] == '(' -> index of the matching ')'."""
    depth, n = 0, len(s)
    while i < n:
        c = s[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < n and s[j] != c:
                j += 2 if s[j] == "\\" else 1
            i = j
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def split_args(a: str):
    args, depth, cur, i = [], 0, [], 0
    while i < len(a):
        c = a[i]
        if c == '"':
            j = i + 1
            while j < len(a) and a[j] != '"':
                j += 2 if a[j] == "\\" else 1
            cur.append(a[i:j + 1]); i = j + 1; continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == "," and depth == 0:
            args.append("".join(cur).strip()); cur = []
        else:
            cur.append(c)
        i += 1
    if "".join(cur).strip():
        args.append("".join(cur).strip())
    return args


def literal(expr: str):
    """"a" "b" -> ab ; otherwise None."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', expr)
    if parts and re.fullmatch(r'\s*(?:"(?:[^"\\]|\\.)*"\s*)+', expr):
        return "".join(parts)
    return None


# --- load functions -------------------------------------------------------------------------------
funcs = {}  # name -> (params[list of (type, name)], body, file)
for f in sorted(list((SRC / "Cedar").glob("*.c")) + list((SRC / "Mayaqua").glob("*.c"))):
    if f.name.startswith("._"):
        continue
    text = strip_disabled(strip_comments(f.read_text(encoding="latin-1")))
    # Expand the two policy macros (string-literal concatenation)
    text = re.sub(r'PACK_ADD_POLICY_BOOL\(\s*"(\w+)"\s*,[^)]*\)', r'PackAddBool(p, "policy:\1", 0)', text)
    text = re.sub(r'PACK_ADD_POLICY_UINT\(\s*"(\w+)"\s*,[^)]*\)', r'PackAddInt(p, "policy:\1", 0)', text)
    for m in re.finditer(r"^[A-Za-z_][\w \t\*]*?\b(\w+)\s*\(([^;{}]*?)\)\s*\{", text, re.M):
        name = m.group(1)
        if name in ("if", "while", "for", "switch"):
            continue
        start = m.end() - 1
        depth, i = 0, start
        while i < len(text):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        params = []
        for p in split_args(m.group(2)):
            pm = re.match(r"(.*?)(\w+)\s*(\[.*\])?$", p.strip())
            if pm:
                params.append((pm.group(1).strip(), pm.group(2)))
        funcs.setdefault(name, (params, text[start + 1:i], f.name))

# --- PackAdd* catalogue ----------------------------------------------------------------------------
# name -> (value type, flags); flags: bool, dt, ip, array (Ex), single (Ex2 is_single arg index)
PACKADD = {
    "PackAddStr": ("STR", False), "PackAddStrEx": ("STR", True),
    "PackAddUniStr": ("UNISTR", False), "PackAddUniStrEx": ("UNISTR", True),
    "PackAddInt": ("INT", False), "PackAddIntEx": ("INT", True), "PackAddNum": ("INT", False),
    "PackAddBool": ("BOOL", False), "PackAddBoolEx": ("BOOL", True),
    "PackAddInt64": ("INT64", False), "PackAddInt64Ex": ("INT64", True),
    "PackAddTime64": ("DT", False), "PackAddTime64Ex": ("DT", True),
    "PackAddData": ("DATA", False), "PackAddDataEx": ("DATA", True),
    "PackAddBuf": ("DATA", False), "PackAddBufEx": ("DATA", True),
    "PackAddX": ("DATA", False), "PackAddK": ("DATA", False), "PackAddXList": ("DATA", True),
    "PackAddIp6Addr": ("DATA", False), "PackAddIp6AddrEx": ("DATA", True),
    "PackAddIp": ("IP", False), "PackAddIp32": ("IP", False),
    "PackAddIpEx": ("IP", True), "PackAddIp32Ex": ("IP", True),
    "PackAddIpEx2": ("IP", "ex2"), "PackAddIp32Ex2": ("IP", "ex2"),
}

problems = []
CALL_RE = re.compile(r"\b([A-Za-z_]\w*)\s*\(")


def walk(fname, packvar, bindings, state, out, stack):
    """Interpret fname's body; `packvar` is the local name of the PACK *, `bindings` maps params to literals."""
    if fname not in funcs or len(stack) > 12 or fname in stack:
        return
    params, body, file = funcs[fname]
    pos = 0
    while True:
        m = CALL_RE.search(body, pos)
        if not m:
            break
        callee = m.group(1)
        lp = body.find("(", m.start())
        rp = match_paren(body, lp)
        if rp < 0:
            break
        args = split_args(body[lp + 1:rp])
        pos = m.end()  # nested calls inside the arguments are scanned too
        if not args or args[0] != packvar and callee not in PACKADD and callee != "PackSetCurrentJsonGroupName":
            # Helper that takes the PACK in another position (OutRpcTrafficEx(&t, p, i, n))
            if callee in funcs and packvar in args and callee not in PACKADD:
                cparams = funcs[callee][0]
                idx = args.index(packvar)
                if idx < len(cparams):
                    nb = {}
                    for k, a in enumerate(args):
                        if k < len(cparams):
                            lit = literal(a)
                            if lit is None and a in bindings:
                                lit = bindings[a]
                            if lit is not None:
                                nb[cparams[k][1]] = lit
                    walk(callee, cparams[idx][1], nb, state, out, stack + [fname])
            continue
        if args[0] != packvar:
            continue
        if callee == "PackSetCurrentJsonGroupName":
            g = literal(args[1]) if len(args) > 1 else None
            if g is None and len(args) > 1 and args[1] in bindings:
                g = bindings[args[1]]
            if g is None and args[1].strip() != "NULL":
                problems.append(f"{stack[0] if stack else fname}: dynamic group name {args[1]!r} in {fname}")
            state["group"] = g or ""
            if g:
                if g not in out["groups"]:
                    out["groups"].append(g)
            continue
        if callee in PACKADD:
            vt, arr = PACKADD[callee]
            nm = literal(args[1]) if len(args) > 1 else None
            if nm is None and len(args) > 1 and args[1] in bindings:
                nm = bindings[args[1]]
            if nm is None:
                if not (fname == "OutRpcCapsList" and args[1] == "tmp"):  # "caps_<name>" scalar INTs: default _u32 is right
                    problems.append(f"{stack[0] if stack else fname}: dynamic element name {args[1]!r} in {fname} ({callee})")
                continue
            if arr == "ex2":
                single = args[-1].strip() in ("true", "1")
                total = args[-2].strip() if len(args) >= 2 else ""
                arr = not single or total not in ("1",)
            rec = {"type": vt, "array": bool(arr), "group": state["group"]}
            prev = out["elements"].get(nm)
            if prev is None:
                out["elements"][nm] = rec
            elif prev != rec:
                # Same name added differently on different code paths: keep both variants for review
                out["conflicts"].setdefault(nm, [prev]).append(rec)
            continue
        if callee in funcs:
            cparams = funcs[callee][0]
            if cparams:
                nb = {}
                for k, a in enumerate(args):
                    if k < len(cparams):
                        lit = literal(a)
                        if lit is None and a in bindings:
                            lit = bindings[a]
                        if lit is not None:
                            nb[cparams[k][1]] = lit
                walk(callee, cparams[0][1], nb, state, out, stack + [fname])


admin = strip_comments((SRC / "Cedar" / "Admin.c").read_text(encoding="latin-1"))
decls = re.findall(r'^\s*DECLARE_RPC(?:_EX)?\("(\w+)",\s*(\w+),\s*(\w+),\s*(\w+),\s*(\w+)', admin, re.M)
methods = {}
for rpc, dtype, fn, in_rpc, out_rpc in decls:
    out = {"elements": {}, "groups": [], "conflicts": {}}
    state = {"group": ""}
    params = funcs.get(out_rpc, ([], "", ""))[0]
    if not params:
        problems.append(f"{rpc}: out_rpc {out_rpc} not found")
        continue
    walk(out_rpc, params[0][1], {}, state, out, [rpc])
    methods[rpc] = out

# --- compact encoding ------------------------------------------------------------------------------
# Per method: { b: bool names, d: datetime names, a: {arrayElementName: group ("" = none)}, g: groups }
# (IP addresses are recognised structurally from their "name@ipv6_bool" companions, but IP arrays and
#  their groups are listed in "a" like every other array.)
table = {}
for rpc, out in methods.items():
    b = sorted(n for n, r in out["elements"].items() if r["type"] == "BOOL")
    d = sorted(n for n, r in out["elements"].items() if r["type"] == "DT")
    a = {n: r["group"] for n, r in sorted(out["elements"].items()) if r["array"]}
    # Scalars added while a group is current also carry the group name, but PackToJson only groups
    # array elements, so scalar group names are irrelevant.
    ent = {}
    if b: ent["b"] = b
    if d: ent["d"] = d
    if a: ent["a"] = a
    if out["groups"]: ent["g"] = out["groups"]
    table[rpc] = ent
    for nm, variants in out["conflicts"].items():
        problems.append(f"{rpc}: element {nm} added with differing hints {variants}")

lines = [f"  {json.dumps(k)}: {json.dumps(v, separators=(',', ':'))}," for k, v in sorted(table.items())]
gen = BEGIN + "\nexport const RESULT_HINTS: Record<string, ResultHint> = {\n" + "\n".join(lines) + "\n};\n" + END
src = OUT.read_text(encoding="utf-8")
if BEGIN not in src or END not in src:
    sys.exit(f"markers not found in {OUT}")
new = src[:src.index(BEGIN)] + gen + src[src.index(END) + len(END):]
if "--check" in sys.argv:
    if new != src:
        sys.exit("pack.ts hints are out of date: run gen-hints.py")
    print("hints up to date")
else:
    OUT.write_text(new, encoding="utf-8")
    print(f"wrote hints for {len(table)} RPCs to {OUT}")
if problems:
    print("\nReview:", *sorted(set(problems)), sep="\n  ")
