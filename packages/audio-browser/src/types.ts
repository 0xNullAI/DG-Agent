export type SpeechServiceMode = 'browser' | 'dashscope-proxy';

export interface BrowserSpeechCapabilities {
  recognitionSupported: boolean;
  synthesisSupported: boolean;
  recognitionMode: SpeechServiceMode;
  synthesisMode: SpeechServiceMode;
  nativeRecognitionSupported: boolean;
  nativeSynthesisSupported: boolean;
  proxyRecognitionSupported: boolean;
  proxySynthesisSupported: boolean;
}

export interface SpeechRecognitionRequest {
  onPartialTranscript?: (text: string) => void;
  manualStop?: boolean;
}

export interface SpeechRecognitionController {
  transcribeOnce(request?: SpeechRecognitionRequest): Promise<string>;
  stop(): void;
  abort(): void;
}

export interface SpeechSynthesizer {
  speak(text: string): Promise<void>;
  createStreamingSession(): SpeechSynthesisSession;
  stop(): void;
}

export interface SpeechSynthesisSession {
  pushAccumulatedText(accumulatedText: string): void;
  finish(finalText?: string): Promise<void>;
  abort(): void;
}

export interface BrowserSpeechRecognitionOptions {
  lang?: string;
  mode?: SpeechServiceMode;
  proxyUrl?: string;
  apiKey?: string;
  autoStopEnabled?: boolean;
}

export interface BrowserSpeechSynthesisOptions {
  lang?: string;
  mode?: SpeechServiceMode;
  proxyUrl?: string;
  apiKey?: string;
  speaker?: string;
  browserVoiceUri?: string;
}

export interface SpeechCapabilityOptions {
  recognitionMode?: SpeechServiceMode;
  synthesisMode?: SpeechServiceMode;
}

export interface BrowserSpeechSynthesisVoiceOption {
  voiceURI: string;
  name: string;
  lang: string;
  default: boolean;
  localService: boolean;
}

export const SPEECH_ABORTED_ERROR_MESSAGE = '语音采集已停止';
export const SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE = '语音合成播放已停止';
export const DEFAULT_PROXY_TTS_SPEAKER = 'longxiaochun_v2';
export const PROXY_TTS_SPEAKERS: Array<{ id: string; label: string }> = [
  { id: DEFAULT_PROXY_TTS_SPEAKER, label: '龙小淳 · 知性积极女 · 中文/英文' },
  { id: 'longyumi_v2', label: 'YUMI · 正经青年女 · 中文/英文' },
  { id: 'longxiaoxia_v2', label: '龙小夏 · 沉稳权威女 · 中文/英文' },
  { id: 'longxiu_v2', label: '龙修 · 博才说书男 · 中文/英文' },
  { id: 'longmiao_v2', label: '龙妙 · 抑扬顿挫女 · 中文/英文' },
  { id: 'longyue_v2', label: '龙悦 · 温暖磁性女 · 中文/英文' },
  { id: 'longnan_v2', label: '龙楠 · 睿智青年男 · 中文/英文' },
  { id: 'longyuan_v2', label: '龙媛 · 温暖治愈女 · 中文/英文' },
  { id: 'longxian_v2', label: '龙仙 · 豪放可爱女 · 中文/英文' },
  { id: 'longlaotie_v2', label: '龙老铁 · 东北直率男 · 东北话/英文' },
  { id: 'longjiayi_v2', label: '龙嘉怡 · 知性粤语女 · 粤语/英文' },
  { id: 'longtao_v2', label: '龙桃 · 积极粤语女 · 粤语/英文' },
  { id: 'longfei_v2', label: '龙飞 · 热血磁性男 · 中文/英文' },
  { id: 'libai_v2', label: '李白 · 古代诗仙男 · 中文/英文' },
  { id: 'longjin_v2', label: '龙津 · 优雅温润男 · 中文/英文' },
  { id: 'longshu_v2', label: '龙书 · 沉稳青年男 · 中文/英文' },
  { id: 'loongbella_v2', label: 'Bella 2.0 · 精准干练女 · 中文/英文' },
  { id: 'longshuo_v2', label: '龙硕 · 博才干练男 · 中文/英文' },
  { id: 'longxiaobai_v2', label: '龙小白 · 沉稳播报女 · 中文/英文' },
  { id: 'longjing_v2', label: '龙婧 · 典型播音女 · 中文/英文' },
  { id: 'loongstella_v2', label: 'Stella · 飒爽利落女 · 中文/英文' },
  { id: 'loongyuuna_v2', label: 'Yuuna · 元气霓虹女 · 日语' },
  { id: 'loongyuuma_v2', label: 'Yuuma · 干练霓虹男 · 日语' },
  { id: 'loongjihun_v2', label: 'Jihun · 阳光韩国男 · 韩语' },
  { id: 'loongeva_v2', label: 'Eva · 知性英文女 · 英式英文' },
  { id: 'loongbrian_v2', label: 'Brian · 沉稳英文男 · 英式英文' },
  { id: 'loongluna_v2', label: 'Luna · 英式英文女 · 英式英文' },
  { id: 'loongluca_v2', label: 'Luca · 英式英文男 · 英式英文' },
  { id: 'loongemily_v2', label: 'Emily · 英式英文女 · 英式英文' },
  { id: 'loongeric_v2', label: 'Eric · 英式英文男 · 英式英文' },
  { id: 'loongabby_v2', label: 'Abby · 美式英文女 · 美式英文' },
  { id: 'loongannie_v2', label: 'Annie · 美式英文女 · 美式英文' },
  { id: 'loongandy_v2', label: 'Andy · 美式英文男 · 美式英文' },
  { id: 'loongava_v2', label: 'Ava · 美式英文女 · 美式英文' },
  { id: 'loongbeth_v2', label: 'Beth · 美式英文女 · 美式英文' },
  { id: 'loongbetty_v2', label: 'Betty · 美式英文女 · 美式英文' },
  { id: 'loongcindy_v2', label: 'Cindy · 美式英文女 · 美式英文' },
  { id: 'loongcally_v2', label: 'Cally · 美式英文女 · 美式英文' },
  { id: 'loongdavid_v2', label: 'David · 美式英文男 · 美式英文' },
];
