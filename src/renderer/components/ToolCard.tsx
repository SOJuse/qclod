import type { RibbonItem } from '../../shared/types'

type Tool = Extract<RibbonItem, { kind: 'tool' }>
type ToolError = Extract<RibbonItem, { kind: 'toolError' }>

/**
 * What each tool is, in one glance.
 *
 * A session makes hundreds of these, and «Bash» next to «Read» next to
 * «Write» in the same grey is why nobody can tell at a distance whether the
 * agent is looking at the code or changing it. Reading is calm, writing is
 * warm, running a command is bright, and the web is its own colour.
 */
const FAMILY: Array<[RegExp, string, string]> = [
  [/^(Read|Glob|Grep|NotebookRead|LSP|ToolSearch)$/, 'read', '👁'],
  [/^(Edit|Write|NotebookEdit|MultiEdit)$/, 'write', '✎'],
  [/^(Bash|PowerShell|BashOutput|KillShell)$/, 'run', '▸'],
  [/^(WebFetch|WebSearch)$/, 'web', '🌐'],
  [/^(Task|Agent)$/, 'agent', '⌁'],
  [/^(TodoWrite|ExitPlanMode|EnterPlanMode)$/, 'plan', '☰'],
  [/^mcp__/, 'mcp', '⬡']
]

function family(name: string): { kind: string; icon: string } {
  for (const [pattern, kind, icon] of FAMILY) {
    if (pattern.test(name)) return { kind, icon }
  }
  return { kind: 'other', icon: '•' }
}

/** MCP tools arrive as `mcp__server__tool`; the middle part is the useful bit. */
function label(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const parts = name.split('__')
  return parts.length >= 3 ? `${parts[1]}: ${parts.slice(2).join('__')}` : name
}

export function ToolCard({ item }: { item: Tool | ToolError }): JSX.Element {
  const { kind, icon } = family(item.name)

  if (item.kind === 'toolError') {
    return (
      <div className="tool-card is-error">
        <div className="tool-head" data-testid="tool-head">
          <span className="tool-icon" aria-hidden>
            {icon}
          </span>
          <span className="tool-name">{label(item.name)}</span>
          <span className="tool-target">{item.target}</span>
          <span className="tool-summary">не получилось</span>
        </div>
        <pre className="tool-detail" data-testid="tool-detail">
          {item.error}
        </pre>
      </div>
    )
  }

  return (
    <details className={`tool-card is-${item.state} tool-${kind}`}>
      <summary className="tool-head" data-testid="tool-head">
        <span className="tool-icon" aria-hidden>
          {icon}
        </span>
        <span className="tool-name">{label(item.name)}</span>
        <span className="tool-target">{item.target}</span>
        <span className="tool-summary">
          {item.state === 'running' ? <span className="tool-spinner">работает…</span> : item.summary}
        </span>
      </summary>
      <pre className="tool-detail" data-testid="tool-detail">
        {item.detail}
      </pre>
    </details>
  )
}
