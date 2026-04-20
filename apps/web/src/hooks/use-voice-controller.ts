import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { RuntimeEvent } from '@dg-agent/core';
import type {
  SpeechRecognitionController,
  SpeechSynthesisSession,
  SpeechSynthesizer,
} from '@dg-agent/audio-browser';
import { isSpeechAbortError, isSpeechSynthesisAbortError } from '../utils/app-runtime-helpers.js';

export interface UseVoiceControllerOptions {
  speechRecognition: SpeechRecognitionController;
  speechSynthesizer: SpeechSynthesizer;
  ttsEnabled: boolean;
  setText: Dispatch<SetStateAction<string>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setStatusMessage: Dispatch<SetStateAction<string | null>>;
}

export function useVoiceController(options: UseVoiceControllerOptions) {
  const {
    speechRecognition,
    speechSynthesizer,
    ttsEnabled,
    setText,
    setErrorMessage,
    setStatusMessage,
  } = options;

  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'speaking'>('idle');
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

  const finishVoiceModeWithTranscript = useCallback(
    (transcript: string): void => {
      const normalized = transcript.trim();
      setVoiceMode(false);
      setVoiceTranscript('');
      setVoiceState('idle');

      if (!normalized) {
        setStatusMessage('未识别到内容');
        return;
      }

      setText((current) => (current ? `${current}\n${normalized}` : normalized));
      setStatusMessage('语音内容已填入输入框，请确认后再发送');
    },
    [setStatusMessage, setText],
  );

  const startVoiceModeCapture = useCallback((): void => {
    setErrorMessage(null);
    setVoiceMode(true);
    setVoiceState('listening');
    setVoiceTranscript('');
    setStatusMessage('语音识别已开始，再次点击结束识别');

    void speechRecognition
      .transcribeOnce({
        manualStop: true,
        onPartialTranscript: (partial) => setVoiceTranscript(partial),
      })
      .then((transcript) => finishVoiceModeWithTranscript(transcript))
      .catch((error) => {
        if (isSpeechAbortError(error)) {
          setVoiceMode(false);
          setVoiceTranscript('');
          setVoiceState('idle');
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setVoiceMode(false);
        setVoiceTranscript('');
        setVoiceState('idle');
      });
  }, [finishVoiceModeWithTranscript, setErrorMessage, setStatusMessage, speechRecognition]);

  const abortVoiceCapture = useCallback((): void => {
    speechRecognition.abort();
    setVoiceMode(false);
    setVoiceTranscript('');
    setVoiceState('idle');
    setStatusMessage('语音录制已停止');
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
    if (!voiceModeRef.current) {
      startVoiceModeCapture();
      return;
    }

    if (voiceState === 'listening') {
      speechRecognition.stop();
      setStatusMessage('正在结束识别…');
    }
  }, [setStatusMessage, speechRecognition, startVoiceModeCapture, voiceState]);

  const handleRuntimeEvent = useCallback(
    (event: RuntimeEvent): void => {
      if (event.type === 'assistant-message-delta' && ttsEnabledRef.current) {
        ensureSpeechSession().pushAccumulatedText(event.content);
        return;
      }

      if (event.type === 'assistant-message-aborted') {
        stopSpeechPlayback();
        setVoiceState('idle');
        setStatusMessage('助手回复已停止');
        return;
      }

      if (event.type !== 'assistant-message-completed') return;

      if (ttsEnabledRef.current && event.message.content.trim()) {
        setVoiceState('speaking');
        void finalizeSpeechSession(event.message.content)
          .catch((error) => {
            if (isSpeechSynthesisAbortError(error)) return;
            setErrorMessage(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            setVoiceState('idle');
          });
        return;
      }
    },
    [
      ensureSpeechSession,
      finalizeSpeechSession,
      setErrorMessage,
      setStatusMessage,
      stopSpeechPlayback,
    ],
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
    abortVoiceCapture,
    toggleVoiceMode,
    stopSpeechPlayback,
    stopAllVoiceActivity,
    handleRuntimeEvent,
  };
}
