import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { RuntimeEvent } from '@dg-agent/core';
import type { SpeechRecognitionController, SpeechSynthesisSession, SpeechSynthesizer } from '@dg-agent/audio-browser';
import { isSpeechAbortError, isSpeechSynthesisAbortError } from '../utils/app-runtime-helpers.js';

type SendTextMessageResult = 'sent' | 'aborted' | 'failed';

export interface UseVoiceControllerOptions {
  speechRecognition: SpeechRecognitionController;
  speechSynthesizer: SpeechSynthesizer;
  ttsEnabled: boolean;
  sendTextMessageRef: MutableRefObject<((message: string) => Promise<SendTextMessageResult>) | null>;
  setText: Dispatch<SetStateAction<string>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setStatusMessage: Dispatch<SetStateAction<string | null>>;
}

export function useVoiceController(options: UseVoiceControllerOptions) {
  const { speechRecognition, speechSynthesizer, ttsEnabled, sendTextMessageRef, setText, setErrorMessage, setStatusMessage } =
    options;

  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'sending' | 'speaking'>('idle');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const speechSessionRef = useRef<SpeechSynthesisSession | null>(null);
  const voiceModeRef = useRef(voiceMode);
  const ttsEnabledRef = useRef(ttsEnabled);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  const ensureSpeechSession = useCallback((): SpeechSynthesisSession => {
    if (!speechSessionRef.current) {
      speechSessionRef.current = speechSynthesizer.createStreamingSession();
    }
    return speechSessionRef.current;
  }, [speechSynthesizer]);

  const finalizeSpeechSession = useCallback(
    async (finalText: string): Promise<void> => {
      const session = speechSessionRef.current ?? speechSynthesizer.createStreamingSession();
      speechSessionRef.current = null;
      await session.finish(finalText);
    },
    [speechSynthesizer],
  );

  const stopSpeechPlayback = useCallback((): void => {
    speechSessionRef.current?.abort();
    speechSessionRef.current = null;
    speechSynthesizer.stop();
  }, [speechSynthesizer]);

  const transcribeVoiceInput = useCallback(async (): Promise<void> => {
    try {
      setErrorMessage(null);
      setVoiceState('listening');
      setVoiceTranscript('');
      const transcript = await speechRecognition.transcribeOnce({
        onPartialTranscript: (partial) => setVoiceTranscript(partial),
      });
      if (!transcript) {
        setStatusMessage('No speech detected.');
        setVoiceState('idle');
        return;
      }

      setVoiceTranscript(transcript);
      setText((current) => (current ? `${current}\n${transcript}` : transcript));
      setStatusMessage('Voice input captured.');
      setVoiceState('idle');
    } catch (error) {
      if (isSpeechAbortError(error)) {
        setVoiceTranscript('');
        setVoiceState('idle');
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setVoiceState('idle');
    }
  }, [setErrorMessage, setStatusMessage, setText, speechRecognition]);

  const captureVoiceAndSend = useCallback(
    async (force = false): Promise<void> => {
      if (!voiceModeRef.current && !force) {
        setVoiceState('idle');
        return;
      }

      try {
        setErrorMessage(null);
        setVoiceState('listening');
        setVoiceTranscript('');
        const transcript = await speechRecognition.transcribeOnce({
          onPartialTranscript: (partial) => setVoiceTranscript(partial),
        });
        if (!voiceModeRef.current && !force) {
          setVoiceState('idle');
          return;
        }

        if (!transcript.trim()) {
          setStatusMessage('No speech detected.');
          setVoiceState('idle');
          return;
        }

        setVoiceTranscript(transcript);
        setText(transcript);
        setVoiceState('sending');
        const result = (await sendTextMessageRef.current?.(transcript)) ?? 'failed';
        if (result === 'sent') {
          setText('');
        } else {
          setVoiceState('idle');
        }
      } catch (error) {
        if (isSpeechAbortError(error)) {
          setVoiceTranscript('');
          setVoiceState('idle');
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setVoiceState('idle');
      }
    },
    [sendTextMessageRef, setErrorMessage, setStatusMessage, setText, speechRecognition],
  );

  const abortVoiceCapture = useCallback((): void => {
    speechRecognition.abort();
    setVoiceTranscript('');
    setVoiceState('idle');
    setStatusMessage('Voice capture stopped.');
  }, [setStatusMessage, speechRecognition]);

  const stopAllVoiceActivity = useCallback(
    (options: { disableMode?: boolean } = {}): void => {
      speechRecognition.abort();
      stopSpeechPlayback();
      setVoiceTranscript('');
      setVoiceState('idle');
      if (options.disableMode ?? true) {
        setVoiceMode(false);
      }
    },
    [speechRecognition, stopSpeechPlayback],
  );

  const toggleVoiceMode = useCallback(async (): Promise<void> => {
    if (voiceModeRef.current) {
      stopAllVoiceActivity({ disableMode: true });
      setStatusMessage('Voice mode stopped.');
      return;
    }

    setVoiceMode(true);
    setVoiceTranscript('');
    setStatusMessage('Voice mode started.');
    await captureVoiceAndSend(true);
  }, [captureVoiceAndSend, setStatusMessage, stopAllVoiceActivity]);

  const handleRuntimeEvent = useCallback(
    (event: RuntimeEvent): void => {
      if (event.type === 'assistant-message-delta' && ttsEnabledRef.current) {
        ensureSpeechSession().pushAccumulatedText(event.content);
        return;
      }

      if (event.type === 'assistant-message-aborted') {
        stopSpeechPlayback();
        setVoiceState('idle');
        setStatusMessage('Assistant reply stopped.');
        return;
      }

      if (event.type !== 'assistant-message-completed') return;

      if (ttsEnabledRef.current && event.message.content.trim()) {
        setVoiceState(voiceModeRef.current ? 'speaking' : 'idle');
        void finalizeSpeechSession(event.message.content)
          .catch((error) => {
            if (isSpeechSynthesisAbortError(error)) return;
            setErrorMessage(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            if (voiceModeRef.current) {
              void captureVoiceAndSend();
            } else {
              setVoiceState('idle');
            }
          });
        return;
      }

      if (voiceModeRef.current) {
        stopSpeechPlayback();
        void captureVoiceAndSend();
      }
    },
    [captureVoiceAndSend, ensureSpeechSession, finalizeSpeechSession, setErrorMessage, setStatusMessage, stopSpeechPlayback],
  );

  useEffect(
    () => () => {
      stopSpeechPlayback();
      speechRecognition.abort();
    },
    [speechRecognition, stopSpeechPlayback],
  );

  return {
    voiceMode,
    setVoiceMode,
    voiceState,
    setVoiceState,
    voiceTranscript,
    setVoiceTranscript,
    transcribeVoiceInput,
    captureVoiceAndSend,
    abortVoiceCapture,
    toggleVoiceMode,
    stopSpeechPlayback,
    stopAllVoiceActivity,
    handleRuntimeEvent,
  };
}
