import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import dotenv from 'dotenv';
import { weatherTool } from '../tools/weather-tool';

dotenv.config();

async function main() {
  const result = await streamText({
    model: openai('gpt-4-turbo'),
    maxTokens: 128,
    temperature: 0.3,
    maxRetries: 5,
    prompt: 'Invent a new holiday and describe its traditions.',
    onFinish({
      usage,
      finishReason,
      text,
      toolCalls,
      toolResults,
      rawResponse,
      warnings,
    }) {
      console.log();
      console.log('onFinish');
      console.log('Token usage:', usage);
      console.log('Finish reason:', finishReason);
      console.log('Text:', text);
    },
  });

  for await (const textPart of result.textStream) {
    process.stdout.write(textPart);
  }
}

main().catch(console.error);
