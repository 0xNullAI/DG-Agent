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
  speechSynthesisEnabled: boolean;
  setText: Dispatch<SetStateAction<string>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setStatusMessage: Dispatch<SetStateAction<string | null>>;
}

export function useVoiceController(options: UseVoiceControllerOptions) {
  const {
    speechRecognition,
    speechSynthesizer,
    speechSynthesisEnabled,
    setText,
    setErrorMessage,
    setStatusMessage,
  } = options;

  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'speaking'>('idle');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const speechSessionRef = useRef<SpeechSynthesisSession | null>(null);
  const recognitionRequestIdRef = useRef(0);
  const voiceModeRef = useRef(voiceMode);
  const voiceTranscriptRef = useRef(voiceTranscript);
  const speechSynthesisEnabledRef = useRef(speechSynthesisEnabled);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  useEffect(() => {
    voiceTranscriptRef.current = voiceTranscript;
  }, [voiceTranscript]);

  useEffect(() => {
    speechSynthesisEnabledRef.current = speechSynthesisEnabled;
  }, [speechSynthesisEnabled]);

  const updateVoiceTranscript = useCallback((transcript: string): void => {
    voiceTranscriptRef.current = transcript;
    setVoiceTranscript(transcript);
  }, []);

  const resetVoiceCaptureState = useCallback((): void => {
    setVoiceMode(false);
    setVoiceState('idle');
    updateVoiceTranscript('');
  }, [updateVoiceTranscript]);

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
      resetVoiceCaptureState();

      if (!normalized) {
        setStatusMessage('未识别到内容');
        return;
      }

      setText((current) => (current ? `${current}\n${normalized}` : normalized));
      setStatusMessage('语音识别结果已填入输入框，请确认后再发送');
    },
    [resetVoiceCaptureState, setStatusMessage, setText],
  );

  const startVoiceModeCapture = useCallback((): void => {
    const requestId = ++recognitionRequestIdRef.current;
    setErrorMessage(null);
    setVoiceMode(true);
    setVoiceState('listening');
    updateVoiceTranscript('');
    setStatusMessage('语音识别已开始，再次点击结束识别');

    void speechRecognition
      .transcribeOnce({
        manualStop: true,
        onPartialTranscript: (partial) => {
          if (recognitionRequestIdRef.current !== requestId) return;
          updateVoiceTranscript(partial);
        },
      })
      .then((transcript) => {
        if (recognitionRequestIdRef.current !== requestId) return;
        finishVoiceModeWithTranscript(transcript || voiceTranscriptRef.current);
      })
      .catch((error) => {
        if (recognitionRequestIdRef.current !== requestId) return;
        if (isSpeechAbortError(error)) {
          resetVoiceCaptureState();
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : String(error));
        resetVoiceCaptureState();
      });
  }, [
    finishVoiceModeWithTranscript,
    resetVoiceCaptureState,
    setErrorMessage,
    setStatusMessage,
    speechRecognition,
    updateVoiceTranscript,
  ]);

  const abortVoiceCapture = useCallback((): void => {
    recognitionRequestIdRef.current += 1;
    speechRecognition.abort();
    resetVoiceCaptureState();
    setStatusMessage('语音识别已停止');
  }, [resetVoiceCaptureState, setStatusMessage, speechRecognition]);

  const stopAllVoiceActivity = useCallback(
    (options: { disableMode?: boolean } = {}): void => {
      recognitionRequestIdRef.current += 1;
      speechRecognition.abort();
      stopSpeechPlayback();
      updateVoiceTranscript('');
      setVoiceState('idle');
      if (options.disableMode ?? true) {
        setVoiceMode(false);
      }
    },
    [speechRecognition, stopSpeechPlayback, updateVoiceTranscript],
  );

  const finalizeLiveTranscriptImmediately = useCallback((): void => {
    const transcript = voiceTranscriptRef.current;
    recognitionRequestIdRef.current += 1;
    speechRecognition.abort();

    if (transcript.trim()) {
      finishVoiceModeWithTranscript(transcript);
      return;
    }

    resetVoiceCaptureState();
    setStatusMessage('语音识别已停止');
  }, [finishVoiceModeWithTranscript, resetVoiceCaptureState, setStatusMessage, speechRecognition]);

  const toggleVoiceMode = useCallback(async (): Promise<void> => {
    if (!voiceModeRef.current) {
      startVoiceModeCapture();
      return;
    }

    if (voiceState === 'listening') {
      finalizeLiveTranscriptImmediately();
    }
  }, [finalizeLiveTranscriptImmediately, startVoiceModeCapture, voiceState]);

  const handleRuntimeEvent = useCallback(
    (event: RuntimeEvent): void => {
      if (event.type === 'assistant-message-delta' && speechSynthesisEnabledRef.current) {
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

      if (speechSynthesisEnabledRef.current && event.message.content.trim()) {
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
