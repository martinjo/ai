import { Readable, Writable, derived, get, writable } from 'svelte/store';
import { callChatApi } from '../shared/call-chat-api';
import { processChatStream } from '../shared/process-chat-stream';
import type {
  ChatRequest,
  ChatRequestOptions,
  CreateMessage,
  IdGenerator,
  JSONValue,
  Message,
  UseChatOptions,
} from '../shared/types';
import { generateId as generateIdFunc } from '../shared/generate-id';
export type { CreateMessage, Message, UseChatOptions };

export type UseChatHelpers = {
  messages: Readable<Message[]>;
  error: Readable<undefined | Error>;
  append: (
    message: Message | CreateMessage,
    chatRequestOptions?: ChatRequestOptions,
  ) => Promise<string | null | undefined>;
  reload: (
    chatRequestOptions?: ChatRequestOptions,
  ) => Promise<string | null | undefined>;
  stop: () => void;
  setMessages: (messages: Message[]) => void;
  input: Writable<string>;
  handleSubmit: (e: any, chatRequestOptions?: ChatRequestOptions) => void;
  metadata?: Object;
  isLoading: Readable<boolean | undefined>;
  data: Readable<JSONValue[] | undefined>;
};

const getStreamedResponse = async (
  api: string,
  chatRequest: ChatRequest,
  mutate: (messages: Message[]) => void,
  mutateStreamData: (data: JSONValue[] | undefined) => void,
  existingData: JSONValue[] | undefined,
  extraMetadata: {
    credentials?: RequestCredentials;
    headers?: Record<string, string> | Headers;
    body?: any;
  },
  previousMessages: Message[],
  abortControllerRef: AbortController | null,
  generateId: IdGenerator,
  streamMode?: 'stream-data' | 'text',
  onFinish?: (message: Message) => void,
  onResponse?: (response: Response) => void | Promise<void>,
  sendExtraMessageFields?: boolean,
) => {
  mutate(chatRequest.messages);

  const constructedMessagesPayload = sendExtraMessageFields
    ? chatRequest.messages
    : chatRequest.messages.map(
        ({ role, content, name, function_call, tool_calls, tool_call_id }) => ({
          role,
          content,
          tool_call_id,
          ...(name !== undefined && { name }),
          ...(function_call !== undefined && {
            function_call: function_call,
          }),
          ...(tool_calls !== undefined && {
            tool_calls: tool_calls,
          }),
        }),
      );

  return await callChatApi({
    api,
    messages: constructedMessagesPayload,
    body: {
      ...extraMetadata.body,
      ...chatRequest.options?.body,
      ...(chatRequest.functions !== undefined && {
        functions: chatRequest.functions,
      }),
      ...(chatRequest.function_call !== undefined && {
        function_call: chatRequest.function_call,
      }),
      ...(chatRequest.tools !== undefined && {
        tools: chatRequest.tools,
      }),
      ...(chatRequest.tool_choice !== undefined && {
        tool_choice: chatRequest.tool_choice,
      }),
    },
    streamMode,
    credentials: extraMetadata.credentials,
    headers: {
      ...extraMetadata.headers,
      ...chatRequest.options?.headers,
    },
    abortController: () => abortControllerRef,
    restoreMessagesOnFailure() {
      mutate(previousMessages);
    },
    onResponse,
    onUpdate(merged, data) {
      mutate([...chatRequest.messages, ...merged]);
      mutateStreamData([...(existingData || []), ...(data || [])]);
    },
    onFinish,
    generateId,
  });
};

let uniqueId = 0;

const store: Record<string, Message[] | undefined> = {};

export function useChat({
  api = '/api/chat',
  id,
  initialMessages = [],
  initialInput = '',
  sendExtraMessageFields,
  experimental_onFunctionCall,
  experimental_onToolCall,
  streamMode,
  onResponse,
  onFinish,
  onError,
  credentials,
  headers,
  body,
  generateId = generateIdFunc,
}: UseChatOptions = {}): UseChatHelpers {
  const chatId = id || `chat-${uniqueId++}`;

  const key = `${api}|${chatId}`;
  const messages = writable<Message[]>(initialMessages);
  const streamData = writable<JSONValue[] | undefined>(undefined);
  const loading = writable<boolean>(false);
  const error = writable<undefined | Error>(undefined);
  const input = writable(initialInput);

  const mutate = (data: Message[]) => {
    store[key] = data;
    messages.set(data);
  };

  let abortController: AbortController | null = null;

  const extraMetadata = {
    credentials,
    headers,
    body,
  };

  async function triggerRequest(chatRequest: ChatRequest) {
    try {
      error.set(undefined);
      loading.set(true);
      abortController = new AbortController();

      await processChatStream({
        getStreamedResponse: () =>
          getStreamedResponse(
            api,
            chatRequest,
            mutate,
            data => {
              streamData.set(data);
            },
            get(streamData),
            extraMetadata,
            get(messages),
            abortController,
            generateId,
            streamMode,
            onFinish,
            onResponse,
            sendExtraMessageFields,
          ),
        experimental_onFunctionCall,
        experimental_onToolCall,
        updateChatRequest: chatRequestParam => {
          chatRequest = chatRequestParam;
        },
        getCurrentMessages: () => get(messages),
      });

      abortController = null;

      return null;
    } catch (err) {
      if ((err as any).name === 'AbortError') {
        abortController = null;
        return null;
      }

      if (onError && err instanceof Error) {
        onError(err);
      }

      error.set(err as Error);
    } finally {
      loading.set(false);
    }
  }

  const append: UseChatHelpers['append'] = async (
    message: Message | CreateMessage,
    {
      options,
      functions,
      function_call,
      tools,
      tool_choice,
    }: ChatRequestOptions = {},
  ) => {
    if (!message.id) {
      message.id = generateId();
    }

    const chatRequest: ChatRequest = {
      messages: get(messages).concat(message as Message),
      options,
      ...(functions !== undefined && { functions }),
      ...(function_call !== undefined && { function_call }),
      ...(tools !== undefined && { tools }),
      ...(tool_choice !== undefined && { tool_choice }),
    };
    return triggerRequest(chatRequest);
  };

  const reload: UseChatHelpers['reload'] = async ({
    options,
    functions,
    function_call,
    tools,
    tool_choice,
  }: ChatRequestOptions = {}) => {
    const messagesSnapshot = get(messages);
    if (messagesSnapshot.length === 0) return null;

    const lastMessage = messagesSnapshot.at(-1);
    if (lastMessage?.role === 'assistant') {
      const chatRequest: ChatRequest = {
        messages: messagesSnapshot.slice(0, -1),
        options,
        ...(functions !== undefined && { functions }),
        ...(function_call !== undefined && { function_call }),
        ...(tools !== undefined && { tools }),
        ...(tool_choice !== undefined && { tool_choice }),
      };

      return triggerRequest(chatRequest);
    }
    const chatRequest: ChatRequest = {
      messages: messagesSnapshot,
      options,
      ...(functions !== undefined && { functions }),
      ...(function_call !== undefined && { function_call }),
      ...(tools !== undefined && { tools }),
      ...(tool_choice !== undefined && { tool_choice }),
    };

    return triggerRequest(chatRequest);
  };

  const stop = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  };

  const setMessages = (messages: Message[]) => {
    mutate(messages);
  };

  const handleSubmit = (e: any, options: ChatRequestOptions = {}) => {
    e.preventDefault();
    const inputValue = get(input);
    if (!inputValue) return;

    append(
      {
        content: inputValue,
        role: 'user',
        createdAt: new Date(),
      },
      options,
    );
    input.set('');
  };

  const isLoading = derived(
    [loading],
    ([$loading]) => {
      return $loading;
    },
  );

  return {
    messages,
    error,
    append,
    reload,
    stop,
    setMessages,
    input,
    handleSubmit,
    isLoading,
    data: streamData,
  };
}
