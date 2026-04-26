/**
 * @dg-agent/waveforms
 *
 * Re-exports the runtime-agnostic waveform helpers from `@dg-kit/waveforms`
 * (built-ins, design compiler, .pulse parser) and adds the browser-only
 * `BrowserWaveformLibrary` (IndexedDB-backed custom waveform store with
 * `.zip` / `.pulse` file import).
 */

export * from '@dg-kit/waveforms';
export * from './browser.js';
