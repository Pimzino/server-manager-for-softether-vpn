/*
 * SoftEther Manager branded setup launcher.
 *
 * A tiny Windows executable that carries a generated MSI as an RCDATA resource ("PAYLOAD") plus a
 * UTF-8 key=value configuration ("CONFIG"), both injected by the management server with resedit
 * (along with the icon and version information). At run time it extracts the MSI to a private temp
 * directory and runs msiexec, which handles elevation itself (the launcher runs asInvoker).
 *
 *   setup.exe                      interactive install (UI level from CONFIG: full | basic)
 *   setup.exe /quiet | /silent | /s    silent install (msiexec /qn)
 *   setup.exe /passive             progress bar only, no questions (msiexec /qb!)
 *   setup.exe /log <file>          verbose MSI log (msiexec /l*v <file>)
 *   setup.exe /uninstall           remove the product (msiexec /x {ProductCode})
 *   setup.exe NAME=value ...       public MSI properties, e.g. VPNUSERNAME=jdoe VPNPASSWORD=...
 *
 * Exit code: msiexec's (0 = success, 3010 = success, reboot required, 1602 = user cancelled).
 *
 * Build (reproducible, from macOS/Linux): see build.sh (mingw-w64).
 */
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stdio.h>

#define MAX_CMD 32768

static wchar_t cfg_title[256] = L"Setup";
static wchar_t cfg_ui[32] = L"basic";
static wchar_t cfg_msi_name[260] = L"setup.msi";
static wchar_t cfg_product_code[64] = L"";
static wchar_t cfg_extra[2048] = L"";

static void fail(const wchar_t *msg, BOOL quiet) {
    if (!quiet) MessageBoxW(NULL, msg, cfg_title, MB_OK | MB_ICONERROR);
}

static const void *load_resource(const wchar_t *name, DWORD *size) {
    HRSRC r = FindResourceW(NULL, name, MAKEINTRESOURCEW(10) /* RT_RCDATA */);
    if (!r) return NULL;
    HGLOBAL g = LoadResource(NULL, r);
    if (!g) return NULL;
    *size = SizeofResource(NULL, r);
    return LockResource(g);
}

/* Parse "key=value" lines (UTF-8) from the CONFIG resource. */
static void load_config(void) {
    DWORD size = 0;
    const char *data = (const char *)load_resource(L"CONFIG", &size);
    if (!data || size == 0 || size > 65536) return;
    int wlen = MultiByteToWideChar(CP_UTF8, 0, data, (int)size, NULL, 0);
    wchar_t *text = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (wlen + 1) * sizeof(wchar_t));
    if (!text) return;
    MultiByteToWideChar(CP_UTF8, 0, data, (int)size, text, wlen);
    wchar_t *ctx = NULL;
    for (wchar_t *line = wcstok(text, L"\r\n", &ctx); line; line = wcstok(NULL, L"\r\n", &ctx)) {
        wchar_t *eq = wcschr(line, L'=');
        if (!eq) continue;
        *eq = 0;
        const wchar_t *k = line, *v = eq + 1;
        if (!wcscmp(k, L"title")) wcsncpy(cfg_title, v, 255);
        else if (!wcscmp(k, L"ui")) wcsncpy(cfg_ui, v, 31);
        else if (!wcscmp(k, L"msiName")) wcsncpy(cfg_msi_name, v, 259);
        else if (!wcscmp(k, L"productCode")) wcsncpy(cfg_product_code, v, 63);
        else if (!wcscmp(k, L"extraArgs")) wcsncpy(cfg_extra, v, 2047);
    }
    HeapFree(GetProcessHeap(), 0, text);
}

/* Append an argument, quoting it for CommandLineToArgvW/msiexec if needed. */
static void append_arg(wchar_t *cmd, const wchar_t *arg) {
    wcsncat(cmd, L" ", MAX_CMD - wcslen(cmd) - 1);
    BOOL quote = wcschr(arg, L' ') || wcschr(arg, L'\t') || !*arg;
    if (!quote) { wcsncat(cmd, arg, MAX_CMD - wcslen(cmd) - 1); return; }
    const wchar_t *eq = wcschr(arg, L'=');
    if (eq && arg[0] != L'/') {
        /* PROPERTY="value with spaces" is the form msiexec expects */
        wcsncat(cmd, arg, MAX_CMD - wcslen(cmd) - 1 < (size_t)(eq - arg + 1) ? 0 : (size_t)(eq - arg + 1));
        wcsncat(cmd, L"\"", MAX_CMD - wcslen(cmd) - 1);
        wcsncat(cmd, eq + 1, MAX_CMD - wcslen(cmd) - 1);
        wcsncat(cmd, L"\"", MAX_CMD - wcslen(cmd) - 1);
    } else {
        wcsncat(cmd, L"\"", MAX_CMD - wcslen(cmd) - 1);
        wcsncat(cmd, arg, MAX_CMD - wcslen(cmd) - 1);
        wcsncat(cmd, L"\"", MAX_CMD - wcslen(cmd) - 1);
    }
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmdline, int show) {
    (void)inst; (void)prev; (void)cmdline; (void)show;
    load_config();

    int argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    BOOL quiet = FALSE, passive = FALSE, uninstall = FALSE;
    const wchar_t *log = NULL;
    static wchar_t props[MAX_CMD];
    props[0] = 0;
    for (int i = 1; i < argc; i++) {
        const wchar_t *a = argv[i];
        if (!_wcsicmp(a, L"/quiet") || !_wcsicmp(a, L"/silent") || !_wcsicmp(a, L"/s") || !_wcsicmp(a, L"/qn")) quiet = TRUE;
        else if (!_wcsicmp(a, L"/passive") || !_wcsicmp(a, L"/qb")) passive = TRUE;
        else if (!_wcsicmp(a, L"/uninstall") || !_wcsicmp(a, L"/x")) uninstall = TRUE;
        else if ((!_wcsicmp(a, L"/log") || !_wcsicmp(a, L"/l")) && i + 1 < argc) log = argv[++i];
        else if (!_wcsicmp(a, L"/?") || !_wcsicmp(a, L"/help")) {
            MessageBoxW(NULL,
                L"Options:\n  /quiet        silent install\n  /passive      progress only\n  /log <file>   write an MSI log\n"
                L"  /uninstall    remove\n  NAME=value    set an installer property", cfg_title, MB_OK | MB_ICONINFORMATION);
            return 0;
        }
        else if (wcschr(a, L'=') && a[0] != L'/') append_arg(props, a);
        else { fail(L"Unknown option. Run setup.exe /? for help.", quiet); return 87; }
    }

    const wchar_t *ui = quiet ? L"/qn" : passive ? L"/qb!" : (!_wcsicmp(cfg_ui, L"full") ? L"/qf" : L"/qb");
    static wchar_t cmd[MAX_CMD];
    wchar_t msi_path[MAX_PATH] = L"", dir[MAX_PATH] = L"";

    if (uninstall) {
        if (!cfg_product_code[0]) { fail(L"This package cannot uninstall (no product code).", quiet); return 1603; }
        swprintf(cmd, MAX_CMD, L"msiexec.exe /x %ls %ls", cfg_product_code, ui);
    } else {
        DWORD size = 0;
        const void *msi = load_resource(L"PAYLOAD", &size);
        if (!msi || size == 0) { fail(L"The installer package is damaged (no payload).", quiet); return 1620; }
        wchar_t tmp[MAX_PATH];
        if (!GetTempPathW(MAX_PATH, tmp)) { fail(L"Cannot locate the temporary folder.", quiet); return 1632; }
        swprintf(dir, MAX_PATH, L"%lssem-setup-%lu-%lu", tmp, GetCurrentProcessId(), GetTickCount());
        if (!CreateDirectoryW(dir, NULL)) { fail(L"Cannot create a temporary folder.", quiet); return 1632; }
        swprintf(msi_path, MAX_PATH, L"%ls\\%ls", dir, cfg_msi_name);
        HANDLE f = CreateFileW(msi_path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (f == INVALID_HANDLE_VALUE) { fail(L"Cannot extract the installer.", quiet); return 1632; }
        DWORD written = 0;
        BOOL ok = WriteFile(f, msi, size, &written, NULL) && written == size;
        CloseHandle(f);
        if (!ok) { DeleteFileW(msi_path); RemoveDirectoryW(dir); fail(L"Cannot extract the installer (disk full?).", quiet); return 1632; }
        swprintf(cmd, MAX_CMD, L"msiexec.exe /i \"%ls\" %ls", msi_path, ui);
    }
    if (log) { wcsncat(cmd, L" /l*v", MAX_CMD - wcslen(cmd) - 1); append_arg(cmd, log); }
    if (cfg_extra[0]) { wcsncat(cmd, L" ", MAX_CMD - wcslen(cmd) - 1); wcsncat(cmd, cfg_extra, MAX_CMD - wcslen(cmd) - 1); }
    wcsncat(cmd, props, MAX_CMD - wcslen(cmd) - 1);

    STARTUPINFOW si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    DWORD code = 1603;
    if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, INFINITE);
        GetExitCodeProcess(pi.hProcess, &code);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    } else {
        fail(L"Cannot start Windows Installer (msiexec.exe).", quiet);
    }
    if (msi_path[0]) DeleteFileW(msi_path);
    if (dir[0]) RemoveDirectoryW(dir);
    if (code != 0 && code != 3010 && code != 1602 && code != 1641) {
        wchar_t msg[256];
        swprintf(msg, 256, L"Installation failed (Windows Installer error %lu).\nRun setup.exe /log setup.log for details.", code);
        fail(msg, quiet || passive);
    }
    LocalFree(argv);
    return (int)code;
}
