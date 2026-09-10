import sys
p='src/server/agent/providers/codex-app-server-agent.ts'
line=int(sys.argv[1])
ls=open(p).read().split('\n')
assert ls[line-1].strip()=='this.flushForegroundTurnClearWaiters();', ls[line-1]
ls[line-1]='    // MUTANT: flush call removed'
open(p,'w').write('\n'.join(ls))
