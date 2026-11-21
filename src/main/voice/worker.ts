// The voice process (utilityProcess): one model, loaded on the first press,
// away from the main process — a native crash here takes only voice down.
import type { SpeechEngine, VoiceActivity } from './engine'
import { EnergyVad } from './energyVad'
import { FakeSpeechEngine } from './fakeEngine'
import type { FromWorker, ModelPaths, ToWorker } from './protocol'
import { SherpaEngine } from './sherpaEngine'
import { SileroVad } from './sileroVad'
import { WhisperServerEngine } from './whisperServerEngine'
import { WorkerCore } from './workerCore'

const port = process.parentPort

/** e2e: a scripted engine instead of a model (buildFlags.d.ts). */
function fakeScript(): string[] | null {
  const raw = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_SPEECH'] : undefined
  if (raw === undefined || raw === '') return null
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

const script = fakeScript()
const crashAfterFinal = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_SPEECH_CRASH'] === '1' : false

function makeEngine(p: ModelPaths, threads: number, prompt: string): SpeechEngine {
  if (__QCLOD_TEST_SEAMS__ && script !== null) return new FakeSpeechEngine(script)
  if (p.kind === 'sherpa') return new SherpaEngine(p, threads)
  return new WhisperServerEngine({
    exe: p.exe,
    ggml: p.ggml,
    threads,
    prompt,
    // main kills it if this process dies first (voiceHost.ts).
    onPid: (pid) => port.postMessage({ type: 'pid', pid } satisfies FromWorker)
  })
}

function makeVad(p: ModelPaths): VoiceActivity {
  if (__QCLOD_TEST_SEAMS__ && script !== null) return new EnergyVad()
  return new SileroVad(p.vad)
}

function post(m: FromWorker): void {
  port.postMessage(m)
  if (__QCLOD_TEST_SEAMS__ && crashAfterFinal && m.type === 'final') {
    // Long enough for the final to reach main first.
    setTimeout(() => process.exit(1), 50)
  }
}

const core = new WorkerCore({ makeEngine, makeVad, post })
port.on('message', (e) => core.handle(e.data as ToWorker))
