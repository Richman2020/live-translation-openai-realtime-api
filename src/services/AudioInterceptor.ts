import { FastifyBaseLogger } from 'fastify';
import WebSocket from 'ws';

import StreamSocket, { MediaBaseAudioMessage } from '@/services/StreamSocket';
import { Config } from '@/config';
import { AI_PROMPT_AGENT, AI_PROMPT_CALLER } from '@/prompts';
import buildRealtimeSessionUpdate from './realtime';

type WebSocketFactory = (
  url: string,
  options: { headers: { Authorization: string } },
) => WebSocket;

type AudioInterceptorOptions = {
  logger: FastifyBaseLogger;
  config: Config;
  callerLanguage: string;
  createWebSocket?: WebSocketFactory;
};

type BufferedMessage = {
  message_id: string;
  first_audio_buffer_add_time?: number;
  vad_speech_stopped_time: number;
};

type OpenAIMessage = {
  event_id: string;
  first_audio_buffer_add_time?: number;
  vad_speech_stopped_time: number;
  type: string;
  delta: string;
  error?: { code?: string; type?: string; message?: string };
  response?: { status: string; status_details?: unknown };
};

export default class AudioInterceptor {
  private readonly logger: FastifyBaseLogger;

  private readonly createWebSocket: WebSocketFactory;

  private config: Config;

  private readonly callerLanguage?: string;

  #callerSocket?: StreamSocket;

  #agentSocket?: StreamSocket;

  #callerOpenAISocket?: WebSocket;

  #agentOpenAISocket?: WebSocket;

  #agentFirstAudioTime?: number;

  #callerMessages: BufferedMessage[] = [];

  #agentMessages: BufferedMessage[] = [];

  #readySessions = new Set<WebSocket>();

  #pendingAudio = new Map<WebSocket, { chunks: string[]; bytes: number }>();

  public constructor(options: AudioInterceptorOptions) {
    this.logger = options.logger;
    this.config = options.config;
    this.callerLanguage = options.callerLanguage;
    this.createWebSocket =
      options.createWebSocket ||
      ((url, settings) => new WebSocket(url, settings));
    this.setupOpenAISockets();
  }

  /**
   * Closes the audio interceptor
   */
  public close() {
    this.#readySessions.clear();
    this.#pendingAudio.clear();
    if (this.#callerSocket) {
      this.#callerSocket.close();
      this.#callerSocket = null;
    }
    if (this.#agentSocket) {
      this.#agentSocket.close();
      this.#agentSocket = null;
    }
    if (this.#callerOpenAISocket) {
      this.#callerOpenAISocket.close();
    }
    if (this.#agentOpenAISocket) {
      this.#agentOpenAISocket.close();
    }

    const callerTime = this.reportOnSocketTimeToFirstAudioBufferAdd(
      this.#callerMessages,
    );
    this.logger.info(`callerAverageTimeToFirstAudioBufferAdd = ${callerTime}`);
    const agentTime = this.reportOnSocketTimeToFirstAudioBufferAdd(
      this.#agentMessages,
    );
    this.logger.info(`agentAverageTimeToFirstAudioBufferAdd = ${agentTime}`);
  }

  /**
   * Starts the audio interception
   */
  public start() {
    if (!this.#agentSocket || !this.#callerSocket) {
      this.logger.error('Both sockets are not set. Cannot start interception');
      return;
    }

    this.logger.info('Initiating the websocket to OpenAI Realtime S2S API');
    // Start Audio Interception
    this.logger.info('Both sockets are set. Starting interception');
    this.#callerSocket.onMedia(this.translateAndForwardCallerAudio.bind(this));
    this.#agentSocket.onMedia(this.translateAndForwardAgentAudio.bind(this));
  }

  private translateAndForwardAgentAudio(message: MediaBaseAudioMessage) {
    if (this.config.FORWARD_AUDIO_BEFORE_TRANSLATION === 'true') {
      this.#callerSocket.send([message.media.payload]);
    }
    // Wait for 1 second after the first time we hear audio from the agent
    // This ensures that we don't send beeps from Flex to OpenAI when the call
    // first connects
    const now = Date.now();
    if (!this.#agentFirstAudioTime) {
      this.#agentFirstAudioTime = now;
    } else if (now - this.#agentFirstAudioTime >= 1000) {
      if (!this.#agentOpenAISocket) {
        this.logger.error('Agent OpenAI WebSocket is not available.');
        return;
      } else {
        this.forwardAudioToOpenAIForTranslation(
          this.#agentOpenAISocket,
          message.media.payload,
        );
      }
    }
  }

  private translateAndForwardCallerAudio(message: MediaBaseAudioMessage) {
    if (this.config.FORWARD_AUDIO_BEFORE_TRANSLATION === 'true') {
      this.#agentSocket.send([message.media.payload]);
    }
    if (!this.#callerOpenAISocket) {
      this.logger.error('Caller OpenAI WebSocket is not available.');
      return;
    }
    this.forwardAudioToOpenAIForTranslation(
      this.#callerOpenAISocket,
      message.media.payload,
    );
  }

  /**
   * Setup the WebSocket connection to OpenAI Realtime S2S API
   * @private
   */
  private setupOpenAISockets() {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.config.OPENAI_REALTIME_MODEL)}`;
    const callerSocket = this.createWebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
      },
    });
    const agentSocket = this.createWebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
      },
    });
    const callerPrompt = AI_PROMPT_CALLER.replace(
      /\[CALLER_LANGUAGE\]/g,
      this.callerLanguage,
    );
    const agentPrompt = AI_PROMPT_AGENT.replace(
      /\[CALLER_LANGUAGE\]/g,
      this.callerLanguage,
    );

    // Store the WebSocket instances
    this.#callerOpenAISocket = callerSocket;
    this.#agentOpenAISocket = agentSocket;

    // Configure the Realtime AI Agents with new 'session.update' client event
    const callerConfigMsg = buildRealtimeSessionUpdate(callerPrompt);
    const agentConfigMsg = buildRealtimeSessionUpdate(agentPrompt);

    // Event listeners for when the connection is opened
    callerSocket.on('open', () => {
      this.logger.info('Caller webSocket connection to OpenAI is open now.');
      // Send the initial prompt/config message to OpenAI for the Translation Agent.
      this.sendMessageToOpenAI(callerSocket, callerConfigMsg);
      this.logger.info(
        callerConfigMsg,
        'Caller session configuration sent; awaiting session.updated:',
      );
    });
    agentSocket.on('open', () => {
      this.logger.info('Agent webSocket connection to OpenAI is open now.');
      // Send the initial prompt/config message to OpenAI for the Translation Agent.
      this.sendMessageToOpenAI(agentSocket, agentConfigMsg);
      this.logger.info(
        agentConfigMsg,
        'Agent session configuration sent; awaiting session.updated:',
      );
    });

    // Event listeners for when a message is received from the server
    callerSocket.on('message', (msg) => {
      this.handleOpenAIMessage(callerSocket, msg.toString(), 'caller');
    });
    agentSocket.on('message', (msg) => {
      this.handleOpenAIMessage(agentSocket, msg.toString(), 'agent');
    });

    // Event listeners for when an error occurs
    callerSocket.on('error', (error: Error) => {
      this.logger.error(`Caller webSocket error: ${error}`);
    });
    agentSocket.on('error', (error: Error) => {
      this.logger.error(`Agent webSocket error: ${error}`);
    });

    // Event listeners for when the connection is closed
    callerSocket.on('close', () => {
      this.#readySessions.delete(callerSocket);
      this.#pendingAudio.delete(callerSocket);
      this.logger.info('Caller webSocket connection to OpenAI is closed now.');
    });

    agentSocket.on('close', () => {
      this.#readySessions.delete(agentSocket);
      this.#pendingAudio.delete(agentSocket);
      this.logger.info('Agent webSocket connection to OpenAI is closed now.');
    });
  }

  private handleOpenAIMessage(
    socket: WebSocket,
    raw: string,
    source: 'caller' | 'agent',
  ) {
    let message: OpenAIMessage;
    try {
      message = JSON.parse(raw) as OpenAIMessage;
    } catch {
      this.logger.error({ source }, 'Invalid JSON received from OpenAI');
      return;
    }
    if (!message || typeof message.type !== 'string') {
      this.logger.error({ source }, 'Invalid event received from OpenAI');
      return;
    }
    if (message.type === 'session.updated') {
      this.#readySessions.add(socket);
      const pending = this.#pendingAudio.get(socket);
      this.#pendingAudio.delete(socket);
      pending?.chunks.forEach((audio) =>
        this.forwardAudioToOpenAIForTranslation(socket, audio),
      );
      this.logger.info({ source }, 'OpenAI Realtime session ready');
      return;
    }
    if (message.type === 'error') {
      this.logger.error(
        { source, error: message.error },
        'OpenAI Realtime error',
      );
      return;
    }
    if (
      message.type === 'response.done' &&
      message.response?.status === 'failed'
    ) {
      this.logger.error(
        { source, details: message.response.status_details },
        'OpenAI translation response failed',
      );
      return;
    }
    const messages =
      source === 'caller' ? this.#callerMessages : this.#agentMessages;
    const now = Date.now();
    if (message.type === 'input_audio_buffer.speech_stopped') {
      messages.push({
        message_id: message.event_id,
        vad_speech_stopped_time: now,
      });
    }
    if (message.type === 'response.output_audio.delta' && message.delta) {
      const latest = messages[messages.length - 1];
      if (latest && !latest.first_audio_buffer_add_time) {
        latest.first_audio_buffer_add_time = now;
      }
      const recipient =
        source === 'caller' ? this.#agentSocket : this.#callerSocket;
      recipient?.send([message.delta]);
    }
  }

  private reportOnSocketTimeToFirstAudioBufferAdd(messages: BufferedMessage[]) {
    const filtered = messages.filter(
      (message) => message.first_audio_buffer_add_time,
    );
    const totalTime = filtered.reduce(
      (acc, { first_audio_buffer_add_time, vad_speech_stopped_time }) =>
        acc + (first_audio_buffer_add_time - vad_speech_stopped_time),
      0,
    );

    return filtered.length ? totalTime / filtered.length : null;
  }

  private forwardAudioToOpenAIForTranslation(socket: WebSocket, audio: string) {
    if (
      socket.readyState !== WebSocket.OPEN &&
      socket.readyState !== WebSocket.CONNECTING
    ) {
      return;
    }
    if (!this.#readySessions.has(socket)) {
      const pending = this.#pendingAudio.get(socket) || {
        chunks: [],
        bytes: 0,
      };
      pending.chunks.push(audio);
      pending.bytes += Buffer.from(audio, 'base64').length;
      // At most two seconds of 8 kHz mu-law while session configuration completes.
      while (pending.bytes > 16000 && pending.chunks.length) {
        pending.bytes -= Buffer.from(pending.chunks.shift(), 'base64').length;
      }
      this.#pendingAudio.set(socket, pending);
      return;
    }
    this.sendMessageToOpenAI(socket, {
      type: 'input_audio_buffer.append',
      audio: audio,
    });
  }

  private sendMessageToOpenAI(socket: WebSocket, message: object) {
    if (socket.readyState === WebSocket.OPEN) {
      const jsonMessage = JSON.stringify(message);
      socket.send(jsonMessage);
    } else {
      this.logger.error('WebSocket is not open. Unable to send message.');
    }
  }

  get callerSocket(): StreamSocket {
    if (!this.#callerSocket) {
      throw new Error('Caller socket not set');
    }
    return this.#callerSocket;
  }

  set callerSocket(value: StreamSocket) {
    this.#callerSocket = value;
  }

  get agentSocket(): StreamSocket {
    if (!this.#agentSocket) {
      throw new Error('Agent socket not set');
    }
    return this.#agentSocket;
  }

  set agentSocket(value: StreamSocket) {
    this.#agentSocket = value;
  }
}
