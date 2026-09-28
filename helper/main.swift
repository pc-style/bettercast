// bettercast-helper: the OS side of Bettercast. The TypeScript core cannot
// call macOS APIs, so it spawns this CLI (see app/src/contract.md
// "Helper CLI"). Every stdout line is ASCII, space-separated, < 4 KiB.

import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    usage("usage: bettercast-helper <watch|paste|copy|open|apps|providers|ax-status|ax-prompt|ai|selftest|--version> [options]")
}
let rest = argv.dropFirst(2)

switch argv[1] {
case "--version", "version":
    Out.line(["bettercast-helper", helperVersion])
    exit(Exit.ok)
case "watch":
    runWatch(Args(rest))
case "paste":
    runPaste(Args(rest))
case "copy":
    runCopy(Args(rest))
case "open":
    runOpen(Args(rest))
case "apps":
    runApps()
case "providers":
    runProviders()
case "ax-status":
    runAXStatus(prompt: false)
case "ax-prompt":
    runAXStatus(prompt: true)
case "ai":
    runAI(Args(rest))
case "selftest":
    runSelftest()
case "debug-pasteboard":
    runDebugPasteboard(Args(rest))
case "debug-key":
    runDebugKey(Args(rest))
default:
    usage("unknown command \(argv[1])")
}
