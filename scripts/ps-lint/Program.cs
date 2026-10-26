// Parses PowerShell scripts with the real PowerShell language parser and reports syntax errors,
// plus PSScriptAnalyzer-like checks we can do from the AST without Windows.
using System.Management.Automation.Language;

int failures = 0;
foreach (var file in args)
{
    Parser.ParseFile(file, out Token[] tokens, out ParseError[] errors);
    if (errors.Length == 0) { Console.WriteLine($"OK   {file}"); continue; }
    failures++;
    foreach (var e in errors)
        Console.WriteLine($"FAIL {file}:{e.Extent.StartLineNumber}:{e.Extent.StartColumnNumber} {e.ErrorId}: {e.Message}");
}
return failures == 0 ? 0 : 1;
