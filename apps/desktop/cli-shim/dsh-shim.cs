// dsh-shim.exe — the Windows launcher DeepSeek Harness installs on PATH.
//
// Windows cannot run a `.cmd` through CreateProcess, so a PATH consumer that is
// not a shell (MissionOS, or any program using exec-style lookup) needs a real
// executable. This shim reads the sibling dsh-shim.json for the application's
// executable and bundled dsh entry, then runs that entry with the application's
// own Electron binary in Node mode, forwarding arguments, standard streams, and
// the exit code.
//
// Built by apps/desktop/scripts/prepare-cli-shim.ts with the .NET Framework
// compiler, so it stays valid C# 5 and depends on nothing but the framework.
using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

internal static class DshShim
{
    private static string ReadValue(string json, string name)
    {
        Match match = Regex.Match(json, "\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        return match.Success ? Regex.Unescape(match.Groups[1].Value) : null;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static int Main(string[] args)
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string config = Path.Combine(Path.GetDirectoryName(self), "dsh-shim.json");
        if (!File.Exists(config))
        {
            Console.Error.WriteLine("dsh: " + config + " is missing; reinstall the command line tool from the application menu");
            return 1;
        }
        string json = File.ReadAllText(config);
        string executable = ReadValue(json, "executable");
        string cliEntry = ReadValue(json, "cliEntry");
        if (executable == null || cliEntry == null)
        {
            Console.Error.WriteLine("dsh: " + config + " does not name an executable and cliEntry");
            return 1;
        }

        ProcessStartInfo start = new ProcessStartInfo(executable);
        start.UseShellExecute = false;
        start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        start.Arguments = Quote("--expose-internals") + " " + Quote(cliEntry)
            + (args.Length == 0 ? string.Empty : " " + string.Join(" ", Array.ConvertAll(args, Quote)));
        try
        {
            using (Process child = Process.Start(start))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("dsh: could not run " + executable + ": " + error.Message);
            return 1;
        }
    }
}
