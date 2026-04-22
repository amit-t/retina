// src/bedrock-provider.ts
import { anthropicTools as anthropicTools2 } from "@ai-sdk/anthropic/internal";
import {
  generateId,
  loadOptionalSetting,
  loadSetting,
  withoutTrailingSlash,
  withUserAgentSuffix as withUserAgentSuffix2
} from "@ai-sdk/provider-utils";

// src/bedrock-chat-language-model.ts
import {
  combineHeaders,
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  parseProviderOptions as parseProviderOptions2,
  postJsonToApi,
  resolve
} from "@ai-sdk/provider-utils";
import { z as z3 } from "zod/v4";

// src/bedrock-api-types.ts
var BEDROCK_STOP_REASONS = [
  "stop",
  "stop_sequence",
  "end_turn",
  "length",
  "max_tokens",
  "content-filter",
  "content_filtered",
  "guardrail_intervened",
  "tool-calls",
  "tool_use"
];
var BEDROCK_IMAGE_MIME_TYPES = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp"
};
var BEDROCK_DOCUMENT_MIME_TYPES = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md"
};

// src/bedrock-chat-options.ts
import { z } from "zod/v4";
var bedrockFilePartProviderOptions = z.object({
  /**
   * Citation configuration for this document.
   * When enabled, this document will generate citations in the response.
   */
  citations: z.object({
    /**
     * Enable citations for this document
     */
    enabled: z.boolean()
  }).optional()
});
var amazonBedrockLanguageModelOptions = z.object({
  /**
   * Additional inference parameters that the model supports,
   * beyond the base set of inference parameters that Converse
   * supports in the inferenceConfig field
   */
  additionalModelRequestFields: z.record(z.string(), z.any()).optional(),
  reasoningConfig: z.object({
    type: z.union([
      z.literal("enabled"),
      z.literal("disabled"),
      z.literal("adaptive")
    ]).optional(),
    budgetTokens: z.number().optional(),
    maxReasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    display: z.enum(["omitted", "summarized"]).optional()
  }).optional(),
  /**
   * Anthropic beta features to enable
   */
  anthropicBeta: z.array(z.string()).optional(),
  /**
   * Service tier for the request.
   * @see https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html
   *
   * - 'reserved': Uses provisioned throughput capacity
   * - 'priority': Prioritizes low-latency inference when capacity is available
   * - 'default': Standard on-demand tier
   * - 'flex': Lower-cost tier for flexible latency workloads
   */
  serviceTier: z.enum(["reserved", "priority", "default", "flex"]).optional()
});

// src/bedrock-error.ts
import { z as z2 } from "zod/v4";
var BedrockErrorSchema = z2.object({
  message: z2.string(),
  type: z2.string().nullish()
});

// src/bedrock-event-stream-response-handler.ts
import { EmptyResponseBodyError } from "@ai-sdk/provider";
import {
  safeParseJSON,
  extractResponseHeaders,
  safeValidateTypes
} from "@ai-sdk/provider-utils";

// src/bedrock-event-stream-decoder.ts
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { toUtf8, fromUtf8 } from "@smithy/util-utf8";
function createBedrockEventStreamDecoder(body, processEvent) {
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  let buffer = new Uint8Array(0);
  const textDecoder = new TextDecoder();
  return body.pipeThrough(
    new TransformStream({
      async transform(chunk, controller) {
        var _a, _b;
        const newBuffer = new Uint8Array(buffer.length + chunk.length);
        newBuffer.set(buffer);
        newBuffer.set(chunk, buffer.length);
        buffer = newBuffer;
        while (buffer.length >= 4) {
          const totalLength = new DataView(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength
          ).getUint32(0, false);
          if (buffer.length < totalLength) {
            break;
          }
          try {
            const subView = buffer.subarray(0, totalLength);
            const decoded = codec.decode(subView);
            buffer = buffer.slice(totalLength);
            const messageType = (_a = decoded.headers[":message-type"]) == null ? void 0 : _a.value;
            const eventType = (_b = decoded.headers[":event-type"]) == null ? void 0 : _b.value;
            const data = textDecoder.decode(decoded.body);
            await processEvent({ messageType, eventType, data }, controller);
          } catch (e) {
            break;
          }
        }
      }
    })
  );
}

// src/bedrock-event-stream-response-handler.ts
var createBedrockEventStreamResponseHandler = (chunkSchema) => async ({ response }) => {
  const responseHeaders = extractResponseHeaders(response);
  if (response.body == null) {
    throw new EmptyResponseBodyError({});
  }
  return {
    responseHeaders,
    value: createBedrockEventStreamDecoder(
      response.body,
      async (event, controller) => {
        if (event.messageType === "event") {
          const parsedDataResult = await safeParseJSON({ text: event.data });
          if (!parsedDataResult.success) {
            controller.enqueue(parsedDataResult);
            return;
          }
          delete parsedDataResult.value.p;
          const wrappedData = {
            [event.eventType]: parsedDataResult.value
          };
          const validatedWrappedData = await safeValidateTypes({
            value: wrappedData,
            schema: chunkSchema
          });
          if (!validatedWrappedData.success) {
            controller.enqueue(validatedWrappedData);
          } else {
            controller.enqueue({
              success: true,
              value: validatedWrappedData.value,
              rawValue: wrappedData
            });
          }
        }
      }
    )
  };
};

// src/bedrock-prepare-tools.ts
import {
  UnsupportedFunctionalityError
} from "@ai-sdk/provider";
import { asSchema } from "@ai-sdk/provider-utils";
import {
  anthropicTools,
  prepareTools as prepareAnthropicTools
} from "@ai-sdk/anthropic/internal";
async function prepareTools({
  tools,
  toolChoice,
  modelId
}) {
  var _a;
  const toolWarnings = [];
  const betas = /* @__PURE__ */ new Set();
  if (tools == null || tools.length === 0) {
    return {
      toolConfig: {},
      additionalTools: void 0,
      betas,
      toolWarnings
    };
  }
  const supportedTools = tools.filter((tool) => {
    if (tool.type === "provider" && tool.id === "anthropic.web_search_20250305") {
      toolWarnings.push({
        type: "unsupported",
        feature: "web_search_20250305 tool",
        details: "The web_search_20250305 tool is not supported on Amazon Bedrock."
      });
      return false;
    }
    return true;
  });
  if (supportedTools.length === 0) {
    return {
      toolConfig: {},
      additionalTools: void 0,
      betas,
      toolWarnings
    };
  }
  const isAnthropicModel = modelId.includes("anthropic.");
  const ProviderTools = supportedTools.filter((t) => t.type === "provider");
  const functionTools = supportedTools.filter((t) => t.type === "function");
  let additionalTools = void 0;
  const bedrockTools = [];
  const usingAnthropicTools = isAnthropicModel && ProviderTools.length > 0;
  if (usingAnthropicTools) {
    const {
      toolChoice: preparedAnthropicToolChoice,
      toolWarnings: anthropicToolWarnings,
      betas: anthropicBetas
    } = await prepareAnthropicTools({
      tools: ProviderTools,
      toolChoice,
      supportsStructuredOutput: false,
      supportsStrictTools: false
    });
    toolWarnings.push(...anthropicToolWarnings);
    anthropicBetas.forEach((beta) => betas.add(beta));
    if (preparedAnthropicToolChoice) {
      additionalTools = {
        tool_choice: preparedAnthropicToolChoice
      };
    }
    for (const tool of ProviderTools) {
      const toolFactory = Object.values(anthropicTools).find((factory) => {
        const instance = factory({});
        return instance.id === tool.id;
      });
      if (toolFactory != null) {
        const fullToolDefinition = toolFactory({});
        bedrockTools.push({
          toolSpec: {
            name: tool.name,
            inputSchema: {
              json: await asSchema(fullToolDefinition.inputSchema).jsonSchema
            }
          }
        });
      } else {
        toolWarnings.push({ type: "unsupported", feature: "tool ${tool.id}" });
      }
    }
  } else {
    for (const tool of ProviderTools) {
      toolWarnings.push({ type: "unsupported", feature: `tool ${tool.id}` });
    }
  }
  const filteredFunctionTools = (toolChoice == null ? void 0 : toolChoice.type) === "tool" ? functionTools.filter((t) => t.name === toolChoice.toolName) : functionTools;
  for (const tool of filteredFunctionTools) {
    bedrockTools.push({
      toolSpec: {
        name: tool.name,
        ...((_a = tool.description) == null ? void 0 : _a.trim()) !== "" ? { description: tool.description } : {},
        ...tool.strict != null ? { strict: tool.strict } : {},
        inputSchema: {
          json: tool.inputSchema
        }
      }
    });
  }
  let bedrockToolChoice = void 0;
  if (!usingAnthropicTools && bedrockTools.length > 0 && toolChoice) {
    const type = toolChoice.type;
    switch (type) {
      case "auto":
        bedrockToolChoice = { auto: {} };
        break;
      case "required":
        bedrockToolChoice = { any: {} };
        break;
      case "none":
        bedrockTools.length = 0;
        bedrockToolChoice = void 0;
        break;
      case "tool":
        bedrockToolChoice = { tool: { name: toolChoice.toolName } };
        break;
      default: {
        const _exhaustiveCheck = type;
        throw new UnsupportedFunctionalityError({
          functionality: `tool choice type: ${_exhaustiveCheck}`
        });
      }
    }
  }
  const toolConfig = bedrockTools.length > 0 ? { tools: bedrockTools, toolChoice: bedrockToolChoice } : {};
  return {
    toolConfig,
    additionalTools,
    betas,
    toolWarnings
  };
}

// src/convert-bedrock-usage.ts
function convertBedrockUsage(usage) {
  var _a, _b;
  if (usage == null) {
    return {
      inputTokens: {
        total: void 0,
        noCache: void 0,
        cacheRead: void 0,
        cacheWrite: void 0
      },
      outputTokens: {
        total: void 0,
        text: void 0,
        reasoning: void 0
      },
      raw: void 0
    };
  }
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const cacheReadTokens = (_a = usage.cacheReadInputTokens) != null ? _a : 0;
  const cacheWriteTokens = (_b = usage.cacheWriteInputTokens) != null ? _b : 0;
  return {
    inputTokens: {
      total: inputTokens + cacheReadTokens + cacheWriteTokens,
      noCache: inputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: void 0
    },
    raw: usage
  };
}

// src/convert-to-bedrock-chat-messages.ts
import {
  UnsupportedFunctionalityError as UnsupportedFunctionalityError2
} from "@ai-sdk/provider";
import {
  convertToBase64,
  parseProviderOptions,
  stripFileExtension
} from "@ai-sdk/provider-utils";

// src/normalize-tool-call-id.ts
function isMistralModel(modelId) {
  return modelId.includes("mistral.");
}
function normalizeToolCallId(toolCallId, isMistral) {
  if (!isMistral) {
    return toolCallId;
  }
  const alphanumericChars = toolCallId.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumericChars.slice(0, 9);
}

// src/convert-to-bedrock-chat-messages.ts
function getCachePoint(providerMetadata) {
  var _a;
  const cachePointConfig = (_a = providerMetadata == null ? void 0 : providerMetadata.bedrock) == null ? void 0 : _a.cachePoint;
  if (!cachePointConfig) {
    return void 0;
  }
  return { cachePoint: cachePointConfig };
}
async function shouldEnableCitations(providerMetadata) {
  var _a, _b;
  const bedrockOptions = await parseProviderOptions({
    provider: "bedrock",
    providerOptions: providerMetadata,
    schema: bedrockFilePartProviderOptions
  });
  return (_b = (_a = bedrockOptions == null ? void 0 : bedrockOptions.citations) == null ? void 0 : _a.enabled) != null ? _b : false;
}
async function convertToBedrockChatMessages(prompt, isMistral = false) {
  var _a;
  const blocks = groupIntoBlocks(prompt);
  let system = [];
  const messages = [];
  let documentCounter = 0;
  const generateDocumentName = () => `document-${++documentCounter}`;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isLastBlock = i === blocks.length - 1;
    const type = block.type;
    switch (type) {
      case "system": {
        if (messages.length > 0) {
          throw new UnsupportedFunctionalityError2({
            functionality: "Multiple system messages that are separated by user/assistant messages"
          });
        }
        for (const message of block.messages) {
          system.push({ text: message.content });
          const cachePoint = getCachePoint(message.providerOptions);
          if (cachePoint) {
            system.push(cachePoint);
          }
        }
        break;
      }
      case "user": {
        const bedrockContent = [];
        for (const message of block.messages) {
          const { role, content, providerOptions } = message;
          switch (role) {
            case "user": {
              for (let j = 0; j < content.length; j++) {
                const part = content[j];
                switch (part.type) {
                  case "text": {
                    bedrockContent.push({
                      text: part.text
                    });
                    break;
                  }
                  case "file": {
                    if (part.data instanceof URL) {
                      throw new UnsupportedFunctionalityError2({
                        functionality: "File URL data"
                      });
                    }
                    if (part.mediaType.startsWith("image/")) {
                      bedrockContent.push({
                        image: {
                          format: getBedrockImageFormat(part.mediaType),
                          source: { bytes: convertToBase64(part.data) }
                        }
                      });
                    } else {
                      if (!part.mediaType) {
                        throw new UnsupportedFunctionalityError2({
                          functionality: "file without mime type",
                          message: "File mime type is required in user message part content"
                        });
                      }
                      const enableCitations = await shouldEnableCitations(
                        part.providerOptions
                      );
                      bedrockContent.push({
                        document: {
                          format: getBedrockDocumentFormat(part.mediaType),
                          name: part.filename ? stripFileExtension(part.filename) : generateDocumentName(),
                          source: { bytes: convertToBase64(part.data) },
                          ...enableCitations && {
                            citations: { enabled: true }
                          }
                        }
                      });
                    }
                    break;
                  }
                }
              }
              break;
            }
            case "tool": {
              for (const part of content) {
                if (part.type === "tool-approval-response") {
                  continue;
                }
                let toolResultContent;
                const output = part.output;
                switch (output.type) {
                  case "content": {
                    toolResultContent = output.value.map((contentPart) => {
                      switch (contentPart.type) {
                        case "text":
                          return { text: contentPart.text };
                        case "image-data":
                          if (!contentPart.mediaType.startsWith("image/")) {
                            throw new UnsupportedFunctionalityError2({
                              functionality: `media type: ${contentPart.mediaType}`
                            });
                          }
                          const format = getBedrockImageFormat(
                            contentPart.mediaType
                          );
                          return {
                            image: {
                              format,
                              source: { bytes: contentPart.data }
                            }
                          };
                        default: {
                          throw new UnsupportedFunctionalityError2({
                            functionality: `unsupported tool content part type: ${contentPart.type}`
                          });
                        }
                      }
                    });
                    break;
                  }
                  case "text":
                  case "error-text":
                    toolResultContent = [{ text: output.value }];
                    break;
                  case "execution-denied":
                    toolResultContent = [
                      { text: (_a = output.reason) != null ? _a : "Tool execution denied." }
                    ];
                    break;
                  case "json":
                  case "error-json":
                  default:
                    toolResultContent = [
                      { text: JSON.stringify(output.value) }
                    ];
                    break;
                }
                bedrockContent.push({
                  toolResult: {
                    toolUseId: normalizeToolCallId(part.toolCallId, isMistral),
                    content: toolResultContent
                  }
                });
              }
              break;
            }
            default: {
              const _exhaustiveCheck = role;
              throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
            }
          }
          const cachePoint = getCachePoint(providerOptions);
          if (cachePoint) {
            bedrockContent.push(cachePoint);
          }
        }
        messages.push({ role: "user", content: bedrockContent });
        break;
      }
      case "assistant": {
        const bedrockContent = [];
        for (let j = 0; j < block.messages.length; j++) {
          const message = block.messages[j];
          const isLastMessage = j === block.messages.length - 1;
          const { content } = message;
          const hasReasoningBlocks = content.some(
            (part) => part.type === "reasoning"
          );
          for (let k = 0; k < content.length; k++) {
            const part = content[k];
            const isLastContentPart = k === content.length - 1;
            switch (part.type) {
              case "text": {
                if (!part.text.trim() && !hasReasoningBlocks) {
                  break;
                }
                bedrockContent.push({
                  text: (
                    // trim the last text part if it's the last message in the block
                    // because Bedrock does not allow trailing whitespace
                    // in pre-filled assistant responses
                    trimIfLast(
                      isLastBlock,
                      isLastMessage,
                      isLastContentPart,
                      part.text
                    )
                  )
                });
                break;
              }
              case "reasoning": {
                const reasoningMetadata = await parseProviderOptions({
                  provider: "bedrock",
                  providerOptions: part.providerOptions,
                  schema: bedrockReasoningMetadataSchema
                });
                if ((reasoningMetadata == null ? void 0 : reasoningMetadata.signature) != null) {
                  bedrockContent.push({
                    reasoningContent: {
                      reasoningText: {
                        text: part.text,
                        signature: reasoningMetadata.signature
                      }
                    }
                  });
                } else if ((reasoningMetadata == null ? void 0 : reasoningMetadata.redactedData) != null) {
                  bedrockContent.push({
                    reasoningContent: {
                      redactedReasoning: {
                        data: reasoningMetadata.redactedData
                      }
                    }
                  });
                } else {
                  bedrockContent.push({
                    reasoningContent: {
                      reasoningText: {
                        text: trimIfLast(
                          isLastBlock,
                          isLastMessage,
                          isLastContentPart,
                          part.text
                        )
                      }
                    }
                  });
                }
                break;
              }
              case "tool-call": {
                bedrockContent.push({
                  toolUse: {
                    toolUseId: normalizeToolCallId(part.toolCallId, isMistral),
                    name: part.toolName,
                    input: part.input
                  }
                });
                break;
              }
            }
          }
          const cachePoint = getCachePoint(message.providerOptions);
          if (cachePoint) {
            bedrockContent.push(cachePoint);
          }
        }
        messages.push({ role: "assistant", content: bedrockContent });
        break;
      }
      default: {
        const _exhaustiveCheck = type;
        throw new Error(`Unsupported type: ${_exhaustiveCheck}`);
      }
    }
  }
  return { system, messages };
}
function getBedrockImageFormat(mimeType) {
  if (!mimeType) {
    throw new UnsupportedFunctionalityError2({
      functionality: "image without mime type",
      message: "Image mime type is required in user message part content"
    });
  }
  const format = BEDROCK_IMAGE_MIME_TYPES[mimeType];
  if (!format) {
    throw new UnsupportedFunctionalityError2({
      functionality: `image mime type: ${mimeType}`,
      message: `Unsupported image mime type: ${mimeType}, expected one of: ${Object.keys(BEDROCK_IMAGE_MIME_TYPES).join(", ")}`
    });
  }
  return format;
}
function getBedrockDocumentFormat(mimeType) {
  const format = BEDROCK_DOCUMENT_MIME_TYPES[mimeType];
  if (!format) {
    throw new UnsupportedFunctionalityError2({
      functionality: `file mime type: ${mimeType}`,
      message: `Unsupported file mime type: ${mimeType}, expected one of: ${Object.keys(BEDROCK_DOCUMENT_MIME_TYPES).join(", ")}`
    });
  }
  return format;
}
function trimIfLast(isLastBlock, isLastMessage, isLastContentPart, text) {
  return isLastBlock && isLastMessage && isLastContentPart ? text.trim() : text;
}
function groupIntoBlocks(prompt) {
  const blocks = [];
  let currentBlock = void 0;
  for (const message of prompt) {
    const { role } = message;
    switch (role) {
      case "system": {
        if ((currentBlock == null ? void 0 : currentBlock.type) !== "system") {
          currentBlock = { type: "system", messages: [] };
          blocks.push(currentBlock);
        }
        currentBlock.messages.push(message);
        break;
      }
      case "assistant": {
        if ((currentBlock == null ? void 0 : currentBlock.type) !== "assistant") {
          currentBlock = { type: "assistant", messages: [] };
          blocks.push(currentBlock);
        }
        currentBlock.messages.push(message);
        break;
      }
      case "user": {
        if ((currentBlock == null ? void 0 : currentBlock.type) !== "user") {
          currentBlock = { type: "user", messages: [] };
          blocks.push(currentBlock);
        }
        currentBlock.messages.push(message);
        break;
      }
      case "tool": {
        if ((currentBlock == null ? void 0 : currentBlock.type) !== "user") {
          currentBlock = { type: "user", messages: [] };
          blocks.push(currentBlock);
        }
        currentBlock.messages.push(message);
        break;
      }
      default: {
        const _exhaustiveCheck = role;
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
      }
    }
  }
  return blocks;
}

// src/map-bedrock-finish-reason.ts
function mapBedrockFinishReason(finishReason, isJsonResponseFromTool) {
  switch (finishReason) {
    case "stop_sequence":
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "content_filtered":
    case "guardrail_intervened":
      return "content-filter";
    case "tool_use":
      return isJsonResponseFromTool ? "stop" : "tool-calls";
    default:
      return "other";
  }
}

// src/bedrock-chat-language-model.ts
var BedrockChatLanguageModel = class {
  constructor(modelId, config) {
    this.modelId = modelId;
    this.config = config;
    this.specificationVersion = "v3";
    this.provider = "amazon-bedrock";
    this.supportedUrls = {
      // no supported urls for bedrock
    };
  }
  async getArgs({
    prompt,
    maxOutputTokens,
    temperature,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    stopSequences,
    responseFormat,
    seed,
    tools,
    toolChoice,
    providerOptions
  }) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
    const bedrockOptions = (_a = await parseProviderOptions2({
      provider: "bedrock",
      providerOptions,
      schema: amazonBedrockLanguageModelOptions
    })) != null ? _a : {};
    const warnings = [];
    if (frequencyPenalty != null) {
      warnings.push({
        type: "unsupported",
        feature: "frequencyPenalty"
      });
    }
    if (presencePenalty != null) {
      warnings.push({
        type: "unsupported",
        feature: "presencePenalty"
      });
    }
    if (seed != null) {
      warnings.push({
        type: "unsupported",
        feature: "seed"
      });
    }
    if (temperature != null && temperature > 1) {
      warnings.push({
        type: "unsupported",
        feature: "temperature",
        details: `${temperature} exceeds bedrock maximum of 1.0. clamped to 1.0`
      });
      temperature = 1;
    } else if (temperature != null && temperature < 0) {
      warnings.push({
        type: "unsupported",
        feature: "temperature",
        details: `${temperature} is below bedrock minimum of 0. clamped to 0`
      });
      temperature = 0;
    }
    if (responseFormat != null && responseFormat.type !== "text" && responseFormat.type !== "json") {
      warnings.push({
        type: "unsupported",
        feature: "responseFormat",
        details: "Only text and json response formats are supported."
      });
    }
    const isAnthropicModel = this.modelId.includes("anthropic");
    const isThinkingEnabled = ((_b = bedrockOptions.reasoningConfig) == null ? void 0 : _b.type) === "enabled" || ((_c = bedrockOptions.reasoningConfig) == null ? void 0 : _c.type) === "adaptive";
    const useNativeStructuredOutput = isAnthropicModel && isThinkingEnabled && (responseFormat == null ? void 0 : responseFormat.type) === "json" && responseFormat.schema != null;
    const jsonResponseTool = (responseFormat == null ? void 0 : responseFormat.type) === "json" && responseFormat.schema != null && !useNativeStructuredOutput ? {
      type: "function",
      name: "json",
      description: "Respond with a JSON object.",
      inputSchema: responseFormat.schema
    } : void 0;
    const { toolConfig, additionalTools, toolWarnings, betas } = await prepareTools({
      tools: jsonResponseTool ? [...tools != null ? tools : [], jsonResponseTool] : tools,
      toolChoice: jsonResponseTool != null ? { type: "required" } : toolChoice,
      modelId: this.modelId
    });
    warnings.push(...toolWarnings);
    if (additionalTools) {
      bedrockOptions.additionalModelRequestFields = {
        ...bedrockOptions.additionalModelRequestFields,
        ...additionalTools
      };
    }
    if (betas.size > 0 || bedrockOptions.anthropicBeta) {
      const existingBetas = (_d = bedrockOptions.anthropicBeta) != null ? _d : [];
      const mergedBetas = betas.size > 0 ? [...existingBetas, ...Array.from(betas)] : existingBetas;
      bedrockOptions.additionalModelRequestFields = {
        ...bedrockOptions.additionalModelRequestFields,
        anthropic_beta: mergedBetas
      };
    }
    const thinkingType = (_e = bedrockOptions.reasoningConfig) == null ? void 0 : _e.type;
    const thinkingBudget = thinkingType === "enabled" ? (_f = bedrockOptions.reasoningConfig) == null ? void 0 : _f.budgetTokens : void 0;
    const thinkingDisplay = thinkingType === "adaptive" ? (_g = bedrockOptions.reasoningConfig) == null ? void 0 : _g.display : void 0;
    const isAnthropicThinkingEnabled = isAnthropicModel && isThinkingEnabled;
    const inferenceConfig = {
      ...maxOutputTokens != null && { maxTokens: maxOutputTokens },
      ...temperature != null && { temperature },
      ...topP != null && { topP },
      ...topK != null && { topK },
      ...stopSequences != null && { stopSequences }
    };
    if (isAnthropicThinkingEnabled) {
      if (thinkingBudget != null) {
        if (inferenceConfig.maxTokens != null) {
          inferenceConfig.maxTokens += thinkingBudget;
        } else {
          inferenceConfig.maxTokens = thinkingBudget + 4096;
        }
        bedrockOptions.additionalModelRequestFields = {
          ...bedrockOptions.additionalModelRequestFields,
          thinking: {
            type: "enabled",
            budget_tokens: thinkingBudget
          }
        };
      } else if (thinkingType === "adaptive") {
        bedrockOptions.additionalModelRequestFields = {
          ...bedrockOptions.additionalModelRequestFields,
          thinking: {
            type: "adaptive",
            ...thinkingDisplay != null && { display: thinkingDisplay }
          }
        };
      }
    } else if (!isAnthropicModel) {
      if (((_h = bedrockOptions.reasoningConfig) == null ? void 0 : _h.budgetTokens) != null) {
        warnings.push({
          type: "unsupported",
          feature: "budgetTokens",
          details: "budgetTokens applies only to Anthropic models on Bedrock and will be ignored for this model."
        });
      }
      if (thinkingType === "adaptive") {
        warnings.push({
          type: "unsupported",
          feature: "adaptive thinking",
          details: "adaptive thinking type applies only to Anthropic models on Bedrock."
        });
      }
    }
    const maxReasoningEffort = (_i = bedrockOptions.reasoningConfig) == null ? void 0 : _i.maxReasoningEffort;
    const isOpenAIModel = this.modelId.startsWith("openai.");
    if (maxReasoningEffort != null) {
      if (isAnthropicModel) {
        bedrockOptions.additionalModelRequestFields = {
          ...bedrockOptions.additionalModelRequestFields,
          output_config: {
            ...(_j = bedrockOptions.additionalModelRequestFields) == null ? void 0 : _j.output_config,
            effort: maxReasoningEffort
          }
        };
      } else if (isOpenAIModel) {
        bedrockOptions.additionalModelRequestFields = {
          ...bedrockOptions.additionalModelRequestFields,
          reasoning_effort: maxReasoningEffort
        };
      } else {
        bedrockOptions.additionalModelRequestFields = {
          ...bedrockOptions.additionalModelRequestFields,
          reasoningConfig: {
            ...thinkingType != null && thinkingType !== "adaptive" && { type: thinkingType },
            ...thinkingBudget != null && { budgetTokens: thinkingBudget },
            maxReasoningEffort
          }
        };
      }
    }
    if (useNativeStructuredOutput) {
      bedrockOptions.additionalModelRequestFields = {
        ...bedrockOptions.additionalModelRequestFields,
        output_config: {
          ...(_k = bedrockOptions.additionalModelRequestFields) == null ? void 0 : _k.output_config,
          format: {
            type: "json_schema",
            schema: responseFormat.schema
          }
        }
      };
    }
    if (isAnthropicThinkingEnabled && inferenceConfig.temperature != null) {
      delete inferenceConfig.temperature;
      warnings.push({
        type: "unsupported",
        feature: "temperature",
        details: "temperature is not supported when thinking is enabled"
      });
    }
    if (isAnthropicThinkingEnabled && inferenceConfig.topP != null) {
      delete inferenceConfig.topP;
      warnings.push({
        type: "unsupported",
        feature: "topP",
        details: "topP is not supported when thinking is enabled"
      });
    }
    if (isAnthropicThinkingEnabled && inferenceConfig.topK != null) {
      delete inferenceConfig.topK;
      warnings.push({
        type: "unsupported",
        feature: "topK",
        details: "topK is not supported when thinking is enabled"
      });
    }
    const hasAnyTools = ((_m = (_l = toolConfig.tools) == null ? void 0 : _l.length) != null ? _m : 0) > 0 || additionalTools;
    let filteredPrompt = prompt;
    if (!hasAnyTools) {
      const hasToolContent = prompt.some(
        (message) => "content" in message && Array.isArray(message.content) && message.content.some(
          (part) => part.type === "tool-call" || part.type === "tool-result"
        )
      );
      if (hasToolContent) {
        filteredPrompt = prompt.map(
          (message) => message.role === "system" ? message : {
            ...message,
            content: message.content.filter(
              (part) => part.type !== "tool-call" && part.type !== "tool-result"
            )
          }
        ).filter(
          (message) => message.role === "system" || message.content.length > 0
        );
        warnings.push({
          type: "unsupported",
          feature: "toolContent",
          details: "Tool calls and results removed from conversation because Bedrock does not support tool content without active tools."
        });
      }
    }
    const isMistral = isMistralModel(this.modelId);
    const { system, messages } = await convertToBedrockChatMessages(
      filteredPrompt,
      isMistral
    );
    const {
      reasoningConfig: _,
      additionalModelRequestFields: __,
      serviceTier: ___,
      ...filteredBedrockOptions
    } = (providerOptions == null ? void 0 : providerOptions.bedrock) || {};
    const additionalModelResponseFieldPaths = isAnthropicModel ? ["/delta/stop_sequence"] : void 0;
    return {
      command: {
        system,
        messages,
        additionalModelRequestFields: bedrockOptions.additionalModelRequestFields,
        ...additionalModelResponseFieldPaths && {
          additionalModelResponseFieldPaths
        },
        ...Object.keys(inferenceConfig).length > 0 && {
          inferenceConfig
        },
        ...bedrockOptions.serviceTier != null && {
          serviceTier: {
            type: bedrockOptions.serviceTier
          }
        },
        ...filteredBedrockOptions,
        ...toolConfig.tools !== void 0 && toolConfig.tools.length > 0 ? { toolConfig } : {}
      },
      warnings,
      usesJsonResponseTool: jsonResponseTool != null,
      betas
    };
  }
  async getHeaders({
    headers
  }) {
    return combineHeaders(await resolve(this.config.headers), headers);
  }
  async doGenerate(options) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
    const {
      command: args,
      warnings,
      usesJsonResponseTool
    } = await this.getArgs(options);
    const url = `${this.getUrl(this.modelId)}/converse`;
    const { value: response, responseHeaders } = await postJsonToApi({
      url,
      headers: await this.getHeaders({ headers: options.headers }),
      body: args,
      failedResponseHandler: createJsonErrorResponseHandler({
        errorSchema: BedrockErrorSchema,
        errorToMessage: (error) => {
          var _a2;
          return `${(_a2 = error.message) != null ? _a2 : "Unknown error"}`;
        }
      }),
      successfulResponseHandler: createJsonResponseHandler(
        BedrockResponseSchema
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const content = [];
    let isJsonResponseFromTool = false;
    for (const part of response.output.message.content) {
      if (part.text != null) {
        content.push({ type: "text", text: part.text });
      }
      if (part.reasoningContent) {
        if ("reasoningText" in part.reasoningContent) {
          const reasoning = {
            type: "reasoning",
            text: part.reasoningContent.reasoningText.text
          };
          if (part.reasoningContent.reasoningText.signature) {
            reasoning.providerMetadata = {
              bedrock: {
                signature: part.reasoningContent.reasoningText.signature
              }
            };
          }
          content.push(reasoning);
        } else if ("redactedReasoning" in part.reasoningContent) {
          content.push({
            type: "reasoning",
            text: "",
            providerMetadata: {
              bedrock: {
                redactedData: (_a = part.reasoningContent.redactedReasoning.data) != null ? _a : ""
              }
            }
          });
        }
      }
      if (part.toolUse) {
        const isJsonResponseTool = usesJsonResponseTool && part.toolUse.name === "json";
        if (isJsonResponseTool) {
          isJsonResponseFromTool = true;
          content.push({
            type: "text",
            text: JSON.stringify(part.toolUse.input)
          });
        } else {
          const isMistral = isMistralModel(this.modelId);
          const rawToolCallId = (_c = (_b = part.toolUse) == null ? void 0 : _b.toolUseId) != null ? _c : this.config.generateId();
          content.push({
            type: "tool-call",
            toolCallId: normalizeToolCallId(rawToolCallId, isMistral),
            toolName: (_e = (_d = part.toolUse) == null ? void 0 : _d.name) != null ? _e : `tool-${this.config.generateId()}`,
            input: JSON.stringify((_g = (_f = part.toolUse) == null ? void 0 : _f.input) != null ? _g : {})
          });
        }
      }
    }
    const stopSequence = (_j = (_i = (_h = response.additionalModelResponseFields) == null ? void 0 : _h.delta) == null ? void 0 : _i.stop_sequence) != null ? _j : null;
    const providerMetadata = response.trace || response.usage || response.performanceConfig || response.serviceTier || isJsonResponseFromTool || stopSequence ? {
      bedrock: {
        ...response.trace && typeof response.trace === "object" ? { trace: response.trace } : {},
        ...response.performanceConfig && {
          performanceConfig: response.performanceConfig
        },
        ...response.serviceTier && {
          serviceTier: response.serviceTier
        },
        ...(((_k = response.usage) == null ? void 0 : _k.cacheWriteInputTokens) != null || ((_l = response.usage) == null ? void 0 : _l.cacheDetails) != null) && {
          usage: {
            ...response.usage.cacheWriteInputTokens != null && {
              cacheWriteInputTokens: response.usage.cacheWriteInputTokens
            },
            ...response.usage.cacheDetails != null && {
              cacheDetails: response.usage.cacheDetails
            }
          }
        },
        ...isJsonResponseFromTool && { isJsonResponseFromTool: true },
        stopSequence
      }
    } : void 0;
    return {
      content,
      finishReason: {
        unified: mapBedrockFinishReason(
          response.stopReason,
          isJsonResponseFromTool
        ),
        raw: (_m = response.stopReason) != null ? _m : void 0
      },
      usage: convertBedrockUsage(response.usage),
      response: {
        id: (_n = responseHeaders == null ? void 0 : responseHeaders["x-amzn-requestid"]) != null ? _n : void 0,
        timestamp: (responseHeaders == null ? void 0 : responseHeaders["date"]) != null ? new Date(responseHeaders["date"]) : void 0,
        modelId: this.modelId,
        headers: responseHeaders
      },
      warnings,
      ...providerMetadata && { providerMetadata }
    };
  }
  async doStream(options) {
    const {
      command: args,
      warnings,
      usesJsonResponseTool
    } = await this.getArgs(options);
    const modelId = this.modelId;
    const isMistral = isMistralModel(modelId);
    const url = `${this.getUrl(modelId)}/converse-stream`;
    const { value: response, responseHeaders } = await postJsonToApi({
      url,
      headers: await this.getHeaders({ headers: options.headers }),
      body: args,
      failedResponseHandler: createJsonErrorResponseHandler({
        errorSchema: BedrockErrorSchema,
        errorToMessage: (error) => `${error.type}: ${error.message}`
      }),
      successfulResponseHandler: createBedrockEventStreamResponseHandler(BedrockStreamSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    let finishReason = {
      unified: "other",
      raw: void 0
    };
    let usage = void 0;
    let providerMetadata = void 0;
    let isJsonResponseFromTool = false;
    let stopSequence = null;
    const contentBlocks = {};
    return {
      stream: response.pipeThrough(
        new TransformStream({
          start(controller) {
            var _a;
            controller.enqueue({ type: "stream-start", warnings });
            controller.enqueue({
              type: "response-metadata",
              id: (_a = responseHeaders == null ? void 0 : responseHeaders["x-amzn-requestid"]) != null ? _a : void 0,
              timestamp: (responseHeaders == null ? void 0 : responseHeaders["date"]) != null ? new Date(responseHeaders["date"]) : void 0,
              modelId
            });
          },
          transform(chunk, controller) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p;
            function enqueueError(bedrockError) {
              finishReason = { unified: "error", raw: void 0 };
              controller.enqueue({ type: "error", error: bedrockError });
            }
            if (options.includeRawChunks) {
              controller.enqueue({ type: "raw", rawValue: chunk.rawValue });
            }
            if (!chunk.success) {
              enqueueError(chunk.error);
              return;
            }
            const value = chunk.value;
            if (value.internalServerException) {
              enqueueError(value.internalServerException);
              return;
            }
            if (value.modelStreamErrorException) {
              enqueueError(value.modelStreamErrorException);
              return;
            }
            if (value.throttlingException) {
              enqueueError(value.throttlingException);
              return;
            }
            if (value.validationException) {
              enqueueError(value.validationException);
              return;
            }
            if (value.messageStop) {
              finishReason = {
                unified: mapBedrockFinishReason(
                  value.messageStop.stopReason,
                  isJsonResponseFromTool
                ),
                raw: (_a = value.messageStop.stopReason) != null ? _a : void 0
              };
              stopSequence = (_d = (_c = (_b = value.messageStop.additionalModelResponseFields) == null ? void 0 : _b.delta) == null ? void 0 : _c.stop_sequence) != null ? _d : null;
            }
            if (value.metadata) {
              if (value.metadata.usage) {
                usage = value.metadata.usage;
              }
              const cacheUsage = ((_e = value.metadata.usage) == null ? void 0 : _e.cacheWriteInputTokens) != null || ((_f = value.metadata.usage) == null ? void 0 : _f.cacheDetails) != null ? {
                usage: {
                  ...((_g = value.metadata.usage) == null ? void 0 : _g.cacheWriteInputTokens) != null && {
                    cacheWriteInputTokens: value.metadata.usage.cacheWriteInputTokens
                  },
                  ...((_h = value.metadata.usage) == null ? void 0 : _h.cacheDetails) != null && {
                    cacheDetails: value.metadata.usage.cacheDetails
                  }
                }
              } : void 0;
              const trace = value.metadata.trace ? {
                trace: value.metadata.trace
              } : void 0;
              if (cacheUsage || trace || value.metadata.performanceConfig || value.metadata.serviceTier) {
                providerMetadata = {
                  bedrock: {
                    ...cacheUsage,
                    ...trace,
                    ...value.metadata.performanceConfig && {
                      performanceConfig: value.metadata.performanceConfig
                    },
                    ...value.metadata.serviceTier && {
                      serviceTier: value.metadata.serviceTier
                    }
                  }
                };
              }
            }
            if (((_i = value.contentBlockStart) == null ? void 0 : _i.contentBlockIndex) != null && !((_k = (_j = value.contentBlockStart) == null ? void 0 : _j.start) == null ? void 0 : _k.toolUse)) {
              const blockIndex = value.contentBlockStart.contentBlockIndex;
              contentBlocks[blockIndex] = { type: "text" };
              controller.enqueue({
                type: "text-start",
                id: String(blockIndex)
              });
            }
            if (((_l = value.contentBlockDelta) == null ? void 0 : _l.delta) && "text" in value.contentBlockDelta.delta && value.contentBlockDelta.delta.text) {
              const blockIndex = value.contentBlockDelta.contentBlockIndex || 0;
              if (contentBlocks[blockIndex] == null) {
                contentBlocks[blockIndex] = { type: "text" };
                controller.enqueue({
                  type: "text-start",
                  id: String(blockIndex)
                });
              }
              controller.enqueue({
                type: "text-delta",
                id: String(blockIndex),
                delta: value.contentBlockDelta.delta.text
              });
            }
            if (((_m = value.contentBlockStop) == null ? void 0 : _m.contentBlockIndex) != null) {
              const blockIndex = value.contentBlockStop.contentBlockIndex;
              const contentBlock = contentBlocks[blockIndex];
              if (contentBlock != null) {
                if (contentBlock.type === "reasoning") {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: String(blockIndex)
                  });
                } else if (contentBlock.type === "text") {
                  controller.enqueue({
                    type: "text-end",
                    id: String(blockIndex)
                  });
                } else if (contentBlock.type === "tool-call") {
                  if (contentBlock.isJsonResponseTool) {
                    isJsonResponseFromTool = true;
                    controller.enqueue({
                      type: "text-start",
                      id: String(blockIndex)
                    });
                    controller.enqueue({
                      type: "text-delta",
                      id: String(blockIndex),
                      delta: contentBlock.jsonText
                    });
                    controller.enqueue({
                      type: "text-end",
                      id: String(blockIndex)
                    });
                  } else {
                    controller.enqueue({
                      type: "tool-input-end",
                      id: contentBlock.toolCallId
                    });
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: contentBlock.toolCallId,
                      toolName: contentBlock.toolName,
                      input: contentBlock.jsonText === "" ? "{}" : contentBlock.jsonText
                    });
                  }
                }
                delete contentBlocks[blockIndex];
              }
            }
            if (((_n = value.contentBlockDelta) == null ? void 0 : _n.delta) && "reasoningContent" in value.contentBlockDelta.delta && value.contentBlockDelta.delta.reasoningContent) {
              const blockIndex = value.contentBlockDelta.contentBlockIndex || 0;
              const reasoningContent = value.contentBlockDelta.delta.reasoningContent;
              if ("text" in reasoningContent && reasoningContent.text) {
                if (contentBlocks[blockIndex] == null) {
                  contentBlocks[blockIndex] = { type: "reasoning" };
                  controller.enqueue({
                    type: "reasoning-start",
                    id: String(blockIndex)
                  });
                }
                controller.enqueue({
                  type: "reasoning-delta",
                  id: String(blockIndex),
                  delta: reasoningContent.text
                });
              } else if ("signature" in reasoningContent && reasoningContent.signature) {
                if (contentBlocks[blockIndex] == null) {
                  contentBlocks[blockIndex] = { type: "reasoning" };
                  controller.enqueue({
                    type: "reasoning-start",
                    id: String(blockIndex)
                  });
                }
                controller.enqueue({
                  type: "reasoning-delta",
                  id: String(blockIndex),
                  delta: "",
                  providerMetadata: {
                    bedrock: {
                      signature: reasoningContent.signature
                    }
                  }
                });
              } else if ("data" in reasoningContent && reasoningContent.data) {
                if (contentBlocks[blockIndex] == null) {
                  contentBlocks[blockIndex] = { type: "reasoning" };
                  controller.enqueue({
                    type: "reasoning-start",
                    id: String(blockIndex)
                  });
                }
                controller.enqueue({
                  type: "reasoning-delta",
                  id: String(blockIndex),
                  delta: "",
                  providerMetadata: {
                    bedrock: {
                      redactedData: reasoningContent.data
                    }
                  }
                });
              }
            }
            const contentBlockStart = value.contentBlockStart;
            if (((_o = contentBlockStart == null ? void 0 : contentBlockStart.start) == null ? void 0 : _o.toolUse) != null) {
              const toolUse = contentBlockStart.start.toolUse;
              const blockIndex = contentBlockStart.contentBlockIndex;
              const isJsonResponseTool = usesJsonResponseTool && toolUse.name === "json";
              const normalizedToolCallId = normalizeToolCallId(
                toolUse.toolUseId,
                isMistral
              );
              contentBlocks[blockIndex] = {
                type: "tool-call",
                toolCallId: normalizedToolCallId,
                toolName: toolUse.name,
                jsonText: "",
                isJsonResponseTool
              };
              if (!isJsonResponseTool) {
                controller.enqueue({
                  type: "tool-input-start",
                  id: normalizedToolCallId,
                  toolName: toolUse.name
                });
              }
            }
            const contentBlockDelta = value.contentBlockDelta;
            if ((contentBlockDelta == null ? void 0 : contentBlockDelta.delta) && "toolUse" in contentBlockDelta.delta && contentBlockDelta.delta.toolUse) {
              const blockIndex = contentBlockDelta.contentBlockIndex;
              const contentBlock = contentBlocks[blockIndex];
              if ((contentBlock == null ? void 0 : contentBlock.type) === "tool-call") {
                const delta = (_p = contentBlockDelta.delta.toolUse.input) != null ? _p : "";
                if (!contentBlock.isJsonResponseTool) {
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: contentBlock.toolCallId,
                    delta
                  });
                }
                contentBlock.jsonText += delta;
              }
            }
          },
          flush(controller) {
            if (isJsonResponseFromTool || stopSequence != null) {
              if (providerMetadata) {
                providerMetadata.bedrock = {
                  ...providerMetadata.bedrock,
                  ...isJsonResponseFromTool && {
                    isJsonResponseFromTool: true
                  },
                  stopSequence
                };
              } else {
                providerMetadata = {
                  bedrock: {
                    ...isJsonResponseFromTool && {
                      isJsonResponseFromTool: true
                    },
                    stopSequence
                  }
                };
              }
            }
            controller.enqueue({
              type: "finish",
              finishReason,
              usage: convertBedrockUsage(usage),
              ...providerMetadata && { providerMetadata }
            });
          }
        })
      ),
      // TODO request?
      response: { headers: responseHeaders }
    };
  }
  getUrl(modelId) {
    const encodedModelId = encodeURIComponent(modelId);
    return `${this.config.baseUrl()}/model/${encodedModelId}`;
  }
};
var BedrockStopReasonSchema = z3.union([
  z3.enum(BEDROCK_STOP_REASONS),
  z3.string()
]);
var BedrockAdditionalModelResponseFieldsSchema = z3.object({
  delta: z3.object({
    stop_sequence: z3.string().nullish()
  }).nullish()
}).catchall(z3.unknown());
var BedrockToolUseSchema = z3.object({
  toolUseId: z3.string(),
  name: z3.string(),
  input: z3.unknown()
});
var BedrockReasoningTextSchema = z3.object({
  signature: z3.string().nullish(),
  text: z3.string()
});
var BedrockRedactedReasoningSchema = z3.object({
  data: z3.string()
});
var BedrockResponseSchema = z3.object({
  metrics: z3.object({
    latencyMs: z3.number()
  }).nullish(),
  output: z3.object({
    message: z3.object({
      content: z3.array(
        z3.object({
          text: z3.string().nullish(),
          toolUse: BedrockToolUseSchema.nullish(),
          reasoningContent: z3.union([
            z3.object({
              reasoningText: BedrockReasoningTextSchema
            }),
            z3.object({
              redactedReasoning: BedrockRedactedReasoningSchema
            })
          ]).nullish()
        })
      ),
      role: z3.string()
    })
  }),
  stopReason: BedrockStopReasonSchema,
  additionalModelResponseFields: BedrockAdditionalModelResponseFieldsSchema.nullish(),
  trace: z3.unknown().nullish(),
  performanceConfig: z3.object({ latency: z3.string() }).nullish(),
  serviceTier: z3.object({ type: z3.string() }).nullish(),
  usage: z3.object({
    inputTokens: z3.number(),
    outputTokens: z3.number(),
    totalTokens: z3.number(),
    cacheReadInputTokens: z3.number().nullish(),
    cacheWriteInputTokens: z3.number().nullish(),
    cacheDetails: z3.array(z3.object({ inputTokens: z3.number(), ttl: z3.string() })).nullish()
  })
});
var BedrockStreamSchema = z3.object({
  contentBlockDelta: z3.object({
    contentBlockIndex: z3.number(),
    delta: z3.union([
      z3.object({ text: z3.string() }),
      z3.object({ toolUse: z3.object({ input: z3.string() }) }),
      z3.object({
        reasoningContent: z3.object({ text: z3.string() })
      }),
      z3.object({
        reasoningContent: z3.object({
          signature: z3.string()
        })
      }),
      z3.object({
        reasoningContent: z3.object({ data: z3.string() })
      })
    ]).nullish()
  }).nullish(),
  contentBlockStart: z3.object({
    contentBlockIndex: z3.number(),
    start: z3.object({
      toolUse: BedrockToolUseSchema.nullish()
    }).nullish()
  }).nullish(),
  contentBlockStop: z3.object({
    contentBlockIndex: z3.number()
  }).nullish(),
  internalServerException: z3.record(z3.string(), z3.unknown()).nullish(),
  messageStop: z3.object({
    additionalModelResponseFields: BedrockAdditionalModelResponseFieldsSchema.nullish(),
    stopReason: BedrockStopReasonSchema
  }).nullish(),
  metadata: z3.object({
    trace: z3.unknown().nullish(),
    performanceConfig: z3.object({ latency: z3.string() }).nullish(),
    serviceTier: z3.object({ type: z3.string() }).nullish(),
    usage: z3.object({
      cacheReadInputTokens: z3.number().nullish(),
      cacheWriteInputTokens: z3.number().nullish(),
      cacheDetails: z3.array(z3.object({ inputTokens: z3.number(), ttl: z3.string() })).nullish(),
      inputTokens: z3.number(),
      outputTokens: z3.number()
    }).nullish()
  }).nullish(),
  modelStreamErrorException: z3.record(z3.string(), z3.unknown()).nullish(),
  throttlingException: z3.record(z3.string(), z3.unknown()).nullish(),
  validationException: z3.record(z3.string(), z3.unknown()).nullish()
});
var bedrockReasoningMetadataSchema = z3.object({
  signature: z3.string().optional(),
  redactedData: z3.string().optional()
});

// src/bedrock-embedding-model.ts
import {
  TooManyEmbeddingValuesForCallError
} from "@ai-sdk/provider";
import {
  combineHeaders as combineHeaders2,
  createJsonErrorResponseHandler as createJsonErrorResponseHandler2,
  createJsonResponseHandler as createJsonResponseHandler2,
  parseProviderOptions as parseProviderOptions3,
  postJsonToApi as postJsonToApi2,
  resolve as resolve2
} from "@ai-sdk/provider-utils";

// src/bedrock-embedding-options.ts
import { z as z4 } from "zod/v4";
var amazonBedrockEmbeddingModelOptionsSchema = z4.object({
  /**
   * The number of dimensions the resulting output embeddings should have (defaults to 1024).
   * Only supported in amazon.titan-embed-text-v2:0.
   */
  dimensions: z4.union([z4.literal(1024), z4.literal(512), z4.literal(256)]).optional(),
  /**
   * Flag indicating whether or not to normalize the output embeddings. Defaults to true.
   * Only supported in amazon.titan-embed-text-v2:0.
   */
  normalize: z4.boolean().optional(),
  /**
   * The number of dimensions for Nova embedding models (defaults to 1024).
   * Supported values: 256, 384, 1024, 3072.
   * Only supported in amazon.nova-* embedding models.
   */
  embeddingDimension: z4.union([z4.literal(256), z4.literal(384), z4.literal(1024), z4.literal(3072)]).optional(),
  /**
   * The purpose of the embedding. Defaults to 'GENERIC_INDEX'.
   * Only supported in amazon.nova-* embedding models.
   */
  embeddingPurpose: z4.enum([
    "GENERIC_INDEX",
    "TEXT_RETRIEVAL",
    "IMAGE_RETRIEVAL",
    "VIDEO_RETRIEVAL",
    "DOCUMENT_RETRIEVAL",
    "AUDIO_RETRIEVAL",
    "GENERIC_RETRIEVAL",
    "CLASSIFICATION",
    "CLUSTERING"
  ]).optional(),
  /**
   * Input type for Cohere embedding models on Bedrock.
   * Common values: `search_document`, `search_query`, `classification`, `clustering`.
   * If not set, the provider defaults to `search_query`.
   */
  inputType: z4.enum(["search_document", "search_query", "classification", "clustering"]).optional(),
  /**
   * Truncation behavior when input exceeds the model's context length.
   * Supported in Cohere and Nova embedding models. Defaults to 'END' for Nova models.
   */
  truncate: z4.enum(["NONE", "START", "END"]).optional(),
  /**
   * The number of dimensions the resulting output embeddings should have (defaults to 1536).
   * Only supported in cohere.embed-v4:0 and newer Cohere embedding models.
   */
  outputDimension: z4.union([z4.literal(256), z4.literal(512), z4.literal(1024), z4.literal(1536)]).optional()
});

// src/bedrock-embedding-model.ts
import { z as z5 } from "zod/v4";
var BedrockEmbeddingModel = class {
  constructor(modelId, config) {
    this.modelId = modelId;
    this.config = config;
    this.specificationVersion = "v3";
    this.provider = "amazon-bedrock";
    this.maxEmbeddingsPerCall = 1;
    this.supportsParallelCalls = true;
  }
  getUrl(modelId) {
    const encodedModelId = encodeURIComponent(modelId);
    return `${this.config.baseUrl()}/model/${encodedModelId}/invoke`;
  }
  async doEmbed({
    values,
    headers,
    abortSignal,
    providerOptions
  }) {
    var _a, _b, _c, _d, _e, _f;
    if (values.length > this.maxEmbeddingsPerCall) {
      throw new TooManyEmbeddingValuesForCallError({
        provider: this.provider,
        modelId: this.modelId,
        maxEmbeddingsPerCall: this.maxEmbeddingsPerCall,
        values
      });
    }
    const bedrockOptions = (_a = await parseProviderOptions3({
      provider: "bedrock",
      providerOptions,
      schema: amazonBedrockEmbeddingModelOptionsSchema
    })) != null ? _a : {};
    const isNovaModel = this.modelId.startsWith("amazon.nova-") && this.modelId.includes("embed");
    const isCohereModel = this.modelId.startsWith("cohere.embed-");
    const args = isNovaModel ? {
      taskType: "SINGLE_EMBEDDING",
      singleEmbeddingParams: {
        embeddingPurpose: (_b = bedrockOptions.embeddingPurpose) != null ? _b : "GENERIC_INDEX",
        embeddingDimension: (_c = bedrockOptions.embeddingDimension) != null ? _c : 1024,
        text: {
          truncationMode: (_d = bedrockOptions.truncate) != null ? _d : "END",
          value: values[0]
        }
      }
    } : isCohereModel ? {
      // Cohere embedding models on Bedrock require `input_type`.
      // Without it, the service attempts other schema branches and rejects the request.
      input_type: (_e = bedrockOptions.inputType) != null ? _e : "search_query",
      texts: [values[0]],
      truncate: bedrockOptions.truncate,
      output_dimension: bedrockOptions.outputDimension
    } : {
      inputText: values[0],
      dimensions: bedrockOptions.dimensions,
      normalize: bedrockOptions.normalize
    };
    const url = this.getUrl(this.modelId);
    const { value: response } = await postJsonToApi2({
      url,
      headers: await resolve2(
        combineHeaders2(await resolve2(this.config.headers), headers)
      ),
      body: args,
      failedResponseHandler: createJsonErrorResponseHandler2({
        errorSchema: BedrockErrorSchema,
        errorToMessage: (error) => `${error.type}: ${error.message}`
      }),
      successfulResponseHandler: createJsonResponseHandler2(
        BedrockEmbeddingResponseSchema
      ),
      fetch: this.config.fetch,
      abortSignal
    });
    let embedding;
    if ("embedding" in response) {
      embedding = response.embedding;
    } else if (Array.isArray(response.embeddings)) {
      const firstEmbedding = response.embeddings[0];
      if (typeof firstEmbedding === "object" && firstEmbedding !== null && "embeddingType" in firstEmbedding) {
        embedding = firstEmbedding.embedding;
      } else {
        embedding = firstEmbedding;
      }
    } else {
      embedding = response.embeddings.float[0];
    }
    const tokens = "inputTextTokenCount" in response ? response.inputTextTokenCount : "inputTokenCount" in response ? (_f = response.inputTokenCount) != null ? _f : 0 : NaN;
    return {
      embeddings: [embedding],
      usage: { tokens },
      warnings: []
    };
  }
};
var BedrockEmbeddingResponseSchema = z5.union([
  // Titan-style response
  z5.object({
    embedding: z5.array(z5.number()),
    inputTextTokenCount: z5.number()
  }),
  // Nova-style response
  z5.object({
    embeddings: z5.array(
      z5.object({
        embeddingType: z5.string(),
        embedding: z5.array(z5.number())
      })
    ),
    inputTokenCount: z5.number().optional()
  }),
  // Cohere v3-style response
  z5.object({
    embeddings: z5.array(z5.array(z5.number()))
  }),
  // Cohere v4-style response
  z5.object({
    embeddings: z5.object({
      float: z5.array(z5.array(z5.number()))
    })
  })
]);

// src/bedrock-image-model.ts
import {
  combineHeaders as combineHeaders3,
  convertUint8ArrayToBase64,
  createJsonErrorResponseHandler as createJsonErrorResponseHandler3,
  createJsonResponseHandler as createJsonResponseHandler3,
  postJsonToApi as postJsonToApi3,
  resolve as resolve3
} from "@ai-sdk/provider-utils";

// src/bedrock-image-settings.ts
var modelMaxImagesPerCall = {
  "amazon.nova-canvas-v1:0": 5
};

// src/bedrock-image-model.ts
import { z as z6 } from "zod/v4";
var BedrockImageModel = class {
  constructor(modelId, config) {
    this.modelId = modelId;
    this.config = config;
    this.specificationVersion = "v3";
    this.provider = "amazon-bedrock";
  }
  get maxImagesPerCall() {
    var _a;
    return (_a = modelMaxImagesPerCall[this.modelId]) != null ? _a : 1;
  }
  getUrl(modelId) {
    const encodedModelId = encodeURIComponent(modelId);
    return `${this.config.baseUrl()}/model/${encodedModelId}/invoke`;
  }
  async doGenerate({
    prompt,
    n,
    size,
    aspectRatio,
    seed,
    providerOptions,
    headers,
    abortSignal,
    files,
    mask
  }) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p;
    const warnings = [];
    const [width, height] = size ? size.split("x").map(Number) : [];
    const hasFiles = files != null && files.length > 0;
    const imageGenerationConfig = {
      ...width ? { width } : {},
      ...height ? { height } : {},
      ...seed ? { seed } : {},
      ...n ? { numberOfImages: n } : {},
      ...((_a = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _a.quality) ? { quality: providerOptions.bedrock.quality } : {},
      ...((_b = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _b.cfgScale) ? { cfgScale: providerOptions.bedrock.cfgScale } : {}
    };
    let args;
    if (hasFiles) {
      const hasMask = (mask == null ? void 0 : mask.type) != null;
      const hasMaskPrompt = ((_c = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _c.maskPrompt) != null;
      const taskType = (_e = (_d = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _d.taskType) != null ? _e : hasMask || hasMaskPrompt ? "INPAINTING" : "IMAGE_VARIATION";
      const sourceImageBase64 = getBase64Data(files[0]);
      switch (taskType) {
        case "INPAINTING": {
          const inPaintingParams = {
            image: sourceImageBase64,
            ...prompt ? { text: prompt } : {},
            ...((_f = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _f.negativeText) ? { negativeText: providerOptions.bedrock.negativeText } : {}
          };
          if (hasMask) {
            inPaintingParams.maskImage = getBase64Data(mask);
          } else if (hasMaskPrompt) {
            inPaintingParams.maskPrompt = providerOptions.bedrock.maskPrompt;
          }
          args = {
            taskType: "INPAINTING",
            inPaintingParams,
            imageGenerationConfig
          };
          break;
        }
        case "OUTPAINTING": {
          const outPaintingParams = {
            image: sourceImageBase64,
            ...prompt ? { text: prompt } : {},
            ...((_g = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _g.negativeText) ? { negativeText: providerOptions.bedrock.negativeText } : {},
            ...((_h = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _h.outPaintingMode) ? { outPaintingMode: providerOptions.bedrock.outPaintingMode } : {}
          };
          if (hasMask) {
            outPaintingParams.maskImage = getBase64Data(mask);
          } else if (hasMaskPrompt) {
            outPaintingParams.maskPrompt = providerOptions.bedrock.maskPrompt;
          }
          args = {
            taskType: "OUTPAINTING",
            outPaintingParams,
            imageGenerationConfig
          };
          break;
        }
        case "BACKGROUND_REMOVAL": {
          args = {
            taskType: "BACKGROUND_REMOVAL",
            backgroundRemovalParams: {
              image: sourceImageBase64
            }
          };
          break;
        }
        case "IMAGE_VARIATION": {
          const images = files.map((file) => getBase64Data(file));
          const imageVariationParams = {
            images,
            ...prompt ? { text: prompt } : {},
            ...((_i = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _i.negativeText) ? { negativeText: providerOptions.bedrock.negativeText } : {},
            ...((_j = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _j.similarityStrength) != null ? {
              similarityStrength: providerOptions.bedrock.similarityStrength
            } : {}
          };
          args = {
            taskType: "IMAGE_VARIATION",
            imageVariationParams,
            imageGenerationConfig
          };
          break;
        }
        default:
          throw new Error(`Unsupported task type: ${taskType}`);
      }
    } else {
      args = {
        taskType: "TEXT_IMAGE",
        textToImageParams: {
          text: prompt,
          ...((_k = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _k.negativeText) ? {
            negativeText: providerOptions.bedrock.negativeText
          } : {},
          ...((_l = providerOptions == null ? void 0 : providerOptions.bedrock) == null ? void 0 : _l.style) ? {
            style: providerOptions.bedrock.style
          } : {}
        },
        imageGenerationConfig
      };
    }
    if (aspectRatio != void 0) {
      warnings.push({
        type: "unsupported",
        feature: "aspectRatio",
        details: "This model does not support aspect ratio. Use `size` instead."
      });
    }
    const currentDate = (_o = (_n = (_m = this.config._internal) == null ? void 0 : _m.currentDate) == null ? void 0 : _n.call(_m)) != null ? _o : /* @__PURE__ */ new Date();
    const { value: response, responseHeaders } = await postJsonToApi3({
      url: this.getUrl(this.modelId),
      headers: await resolve3(
        combineHeaders3(await resolve3(this.config.headers), headers)
      ),
      body: args,
      failedResponseHandler: createJsonErrorResponseHandler3({
        errorSchema: BedrockErrorSchema,
        errorToMessage: (error) => `${error.type}: ${error.message}`
      }),
      successfulResponseHandler: createJsonResponseHandler3(
        bedrockImageResponseSchema
      ),
      abortSignal,
      fetch: this.config.fetch
    });
    if (response.status === "Request Moderated") {
      const moderationReasons = (_p = response.details) == null ? void 0 : _p["Moderation Reasons"];
      const reasons = Array.isArray(moderationReasons) ? moderationReasons : ["Unknown"];
      throw new Error(
        `Amazon Bedrock request was moderated: ${reasons.join(", ")}`
      );
    }
    if (!response.images || response.images.length === 0) {
      throw new Error(
        "Amazon Bedrock returned no images. " + (response.status ? `Status: ${response.status}` : "")
      );
    }
    return {
      images: response.images,
      warnings,
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders
      }
    };
  }
};
function getBase64Data(file) {
  if (file.type === "url") {
    throw new Error(
      "URL-based images are not supported for Amazon Bedrock image editing. Please provide the image data directly."
    );
  }
  if (file.data instanceof Uint8Array) {
    return convertUint8ArrayToBase64(file.data);
  }
  return file.data;
}
var bedrockImageResponseSchema = z6.object({
  // Normal successful response
  images: z6.array(z6.string()).optional(),
  // Moderation response fields
  id: z6.string().optional(),
  status: z6.string().optional(),
  result: z6.unknown().optional(),
  progress: z6.unknown().optional(),
  details: z6.record(z6.string(), z6.unknown()).optional(),
  preview: z6.unknown().optional()
});

// src/bedrock-sigv4-fetch.ts
import {
  combineHeaders as combineHeaders4,
  normalizeHeaders,
  withUserAgentSuffix,
  getRuntimeEnvironmentUserAgent
} from "@ai-sdk/provider-utils";
import { AwsV4Signer } from "aws4fetch";

// src/version.ts
var VERSION = true ? "4.0.96" : "0.0.0-test";

// src/bedrock-sigv4-fetch.ts
function createSigV4FetchFunction(getCredentials, fetch = globalThis.fetch) {
  return async (input, init) => {
    var _a, _b;
    const request = input instanceof Request ? input : void 0;
    const originalHeaders = combineHeaders4(
      normalizeHeaders(request == null ? void 0 : request.headers),
      normalizeHeaders(init == null ? void 0 : init.headers)
    );
    const headersWithUserAgent = withUserAgentSuffix(
      originalHeaders,
      `ai-sdk/amazon-bedrock/${VERSION}`,
      getRuntimeEnvironmentUserAgent()
    );
    let effectiveBody = (_a = init == null ? void 0 : init.body) != null ? _a : void 0;
    if (effectiveBody === void 0 && request && request.body !== null) {
      try {
        effectiveBody = await request.clone().text();
      } catch (e) {
      }
    }
    const effectiveMethod = (_b = init == null ? void 0 : init.method) != null ? _b : request == null ? void 0 : request.method;
    if ((effectiveMethod == null ? void 0 : effectiveMethod.toUpperCase()) !== "POST" || !effectiveBody) {
      return fetch(input, {
        ...init,
        headers: headersWithUserAgent
      });
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = prepareBodyString(effectiveBody);
    const credentials = await getCredentials();
    const signer = new AwsV4Signer({
      url,
      method: "POST",
      headers: Object.entries(headersWithUserAgent),
      body,
      region: credentials.region,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      service: "bedrock"
    });
    const signingResult = await signer.sign();
    const signedHeaders = normalizeHeaders(signingResult.headers);
    const combinedHeaders = combineHeaders4(headersWithUserAgent, signedHeaders);
    return fetch(input, {
      ...init,
      body,
      headers: combinedHeaders
    });
  };
}
function prepareBodyString(body) {
  if (typeof body === "string") {
    return body;
  } else if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  } else if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  } else {
    return JSON.stringify(body);
  }
}
function createApiKeyFetchFunction(apiKey, fetch = globalThis.fetch) {
  return async (input, init) => {
    const originalHeaders = normalizeHeaders(init == null ? void 0 : init.headers);
    const headersWithUserAgent = withUserAgentSuffix(
      originalHeaders,
      `ai-sdk/amazon-bedrock/${VERSION}`,
      getRuntimeEnvironmentUserAgent()
    );
    const finalHeaders = combineHeaders4(headersWithUserAgent, {
      Authorization: `Bearer ${apiKey}`
    });
    return fetch(input, {
      ...init,
      headers: finalHeaders
    });
  };
}

// src/reranking/bedrock-reranking-model.ts
import {
  combineHeaders as combineHeaders5,
  createJsonErrorResponseHandler as createJsonErrorResponseHandler4,
  createJsonResponseHandler as createJsonResponseHandler4,
  parseProviderOptions as parseProviderOptions4,
  postJsonToApi as postJsonToApi4,
  resolve as resolve4
} from "@ai-sdk/provider-utils";

// src/reranking/bedrock-reranking-api.ts
import { lazySchema, zodSchema } from "@ai-sdk/provider-utils";
import { z as z7 } from "zod/v4";
var bedrockRerankingResponseSchema = lazySchema(
  () => zodSchema(
    z7.object({
      results: z7.array(
        z7.object({
          index: z7.number(),
          relevanceScore: z7.number()
        })
      ),
      nextToken: z7.string().optional()
    })
  )
);

// src/reranking/bedrock-reranking-options.ts
import { lazySchema as lazySchema2, zodSchema as zodSchema2 } from "@ai-sdk/provider-utils";
import { z as z8 } from "zod/v4";
var amazonBedrockRerankingModelOptionsSchema = lazySchema2(
  () => zodSchema2(
    z8.object({
      /**
       * If the total number of results was greater than could fit in a response, a token is returned in the nextToken field. You can enter that token in this field to return the next batch of results.
       */
      nextToken: z8.string().optional(),
      /**
       * Additional model request fields to pass to the model.
       */
      additionalModelRequestFields: z8.record(z8.string(), z8.any()).optional()
    })
  )
);

// src/reranking/bedrock-reranking-model.ts
var BedrockRerankingModel = class {
  constructor(modelId, config) {
    this.modelId = modelId;
    this.config = config;
    this.specificationVersion = "v3";
    this.provider = "amazon-bedrock";
  }
  async doRerank({
    documents,
    headers,
    query,
    topN,
    abortSignal,
    providerOptions
  }) {
    const bedrockOptions = await parseProviderOptions4({
      provider: "bedrock",
      providerOptions,
      schema: amazonBedrockRerankingModelOptionsSchema
    });
    const {
      value: response,
      responseHeaders,
      rawValue
    } = await postJsonToApi4({
      url: `${this.config.baseUrl()}/rerank`,
      headers: await resolve4(
        combineHeaders5(await resolve4(this.config.headers), headers)
      ),
      body: {
        nextToken: bedrockOptions == null ? void 0 : bedrockOptions.nextToken,
        queries: [
          {
            textQuery: { text: query },
            type: "TEXT"
          }
        ],
        rerankingConfiguration: {
          bedrockRerankingConfiguration: {
            modelConfiguration: {
              modelArn: `arn:aws:bedrock:${this.config.region}::foundation-model/${this.modelId}`,
              additionalModelRequestFields: bedrockOptions == null ? void 0 : bedrockOptions.additionalModelRequestFields
            },
            numberOfResults: topN
          },
          type: "BEDROCK_RERANKING_MODEL"
        },
        sources: documents.values.map((value) => ({
          type: "INLINE",
          inlineDocumentSource: documents.type === "text" ? {
            type: "TEXT",
            textDocument: { text: value }
          } : {
            type: "JSON",
            jsonDocument: value
          }
        }))
      },
      failedResponseHandler: createJsonErrorResponseHandler4({
        errorSchema: BedrockErrorSchema,
        errorToMessage: (error) => `${error.type}: ${error.message}`
      }),
      successfulResponseHandler: createJsonResponseHandler4(
        bedrockRerankingResponseSchema
      ),
      fetch: this.config.fetch,
      abortSignal
    });
    return {
      ranking: response.results,
      response: {
        headers: responseHeaders,
        body: rawValue
      }
    };
  }
};

// src/bedrock-provider.ts
function createAmazonBedrock(options = {}) {
  const rawApiKey = loadOptionalSetting({
    settingValue: options.apiKey,
    environmentVariableName: "AWS_BEARER_TOKEN_BEDROCK"
  });
  const apiKey = rawApiKey && rawApiKey.trim().length > 0 ? rawApiKey.trim() : void 0;
  const fetchFunction = apiKey ? createApiKeyFetchFunction(apiKey, options.fetch) : createSigV4FetchFunction(async () => {
    const region = loadSetting({
      settingValue: options.region,
      settingName: "region",
      environmentVariableName: "AWS_REGION",
      description: "AWS region"
    });
    if (options.credentialProvider) {
      try {
        return {
          ...await options.credentialProvider(),
          region
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `AWS credential provider failed: ${errorMessage}. Please ensure your credential provider returns valid AWS credentials with accessKeyId and secretAccessKey properties.`
        );
      }
    }
    try {
      return {
        region,
        accessKeyId: loadSetting({
          settingValue: options.accessKeyId,
          settingName: "accessKeyId",
          environmentVariableName: "AWS_ACCESS_KEY_ID",
          description: "AWS access key ID"
        }),
        secretAccessKey: loadSetting({
          settingValue: options.secretAccessKey,
          settingName: "secretAccessKey",
          environmentVariableName: "AWS_SECRET_ACCESS_KEY",
          description: "AWS secret access key"
        }),
        sessionToken: loadOptionalSetting({
          settingValue: options.sessionToken,
          environmentVariableName: "AWS_SESSION_TOKEN"
        })
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("AWS_ACCESS_KEY_ID") || errorMessage.includes("accessKeyId")) {
        throw new Error(
          `AWS SigV4 authentication requires AWS credentials. Please provide either:
1. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables
2. Provide accessKeyId and secretAccessKey in options
3. Use a credentialProvider function
4. Use API key authentication with AWS_BEARER_TOKEN_BEDROCK or apiKey option
Original error: ${errorMessage}`
        );
      }
      if (errorMessage.includes("AWS_SECRET_ACCESS_KEY") || errorMessage.includes("secretAccessKey")) {
        throw new Error(
          `AWS SigV4 authentication requires both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. Please ensure both credentials are provided.
Original error: ${errorMessage}`
        );
      }
      throw error;
    }
  }, options.fetch);
  const getHeaders = () => {
    var _a;
    const baseHeaders = (_a = options.headers) != null ? _a : {};
    return withUserAgentSuffix2(baseHeaders, `ai-sdk/amazon-bedrock/${VERSION}`);
  };
  const getBedrockRuntimeBaseUrl = () => {
    var _a, _b;
    return (_b = withoutTrailingSlash(
      (_a = options.baseURL) != null ? _a : `https://bedrock-runtime.${loadSetting({
        settingValue: options.region,
        settingName: "region",
        environmentVariableName: "AWS_REGION",
        description: "AWS region"
      })}.amazonaws.com`
    )) != null ? _b : `https://bedrock-runtime.us-east-1.amazonaws.com`;
  };
  const getBedrockAgentRuntimeBaseUrl = () => {
    var _a, _b;
    return (_b = withoutTrailingSlash(
      (_a = options.baseURL) != null ? _a : `https://bedrock-agent-runtime.${loadSetting({
        settingValue: options.region,
        settingName: "region",
        environmentVariableName: "AWS_REGION",
        description: "AWS region"
      })}.amazonaws.com`
    )) != null ? _b : `https://bedrock-agent-runtime.us-west-2.amazonaws.com`;
  };
  const createChatModel = (modelId) => new BedrockChatLanguageModel(modelId, {
    baseUrl: getBedrockRuntimeBaseUrl,
    headers: getHeaders,
    fetch: fetchFunction,
    generateId
  });
  const provider = function(modelId) {
    if (new.target) {
      throw new Error(
        "The Amazon Bedrock model function cannot be called with the new keyword."
      );
    }
    return createChatModel(modelId);
  };
  const createEmbeddingModel = (modelId) => new BedrockEmbeddingModel(modelId, {
    baseUrl: getBedrockRuntimeBaseUrl,
    headers: getHeaders,
    fetch: fetchFunction
  });
  const createImageModel = (modelId) => new BedrockImageModel(modelId, {
    baseUrl: getBedrockRuntimeBaseUrl,
    headers: getHeaders,
    fetch: fetchFunction
  });
  const createRerankingModel = (modelId) => new BedrockRerankingModel(modelId, {
    baseUrl: getBedrockAgentRuntimeBaseUrl,
    region: loadSetting({
      settingValue: options.region,
      settingName: "region",
      environmentVariableName: "AWS_REGION",
      description: "AWS region"
    }),
    headers: getHeaders,
    fetch: fetchFunction
  });
  provider.specificationVersion = "v3";
  provider.languageModel = createChatModel;
  provider.embedding = createEmbeddingModel;
  provider.embeddingModel = createEmbeddingModel;
  provider.textEmbedding = createEmbeddingModel;
  provider.textEmbeddingModel = createEmbeddingModel;
  provider.image = createImageModel;
  provider.imageModel = createImageModel;
  provider.reranking = createRerankingModel;
  provider.rerankingModel = createRerankingModel;
  provider.tools = anthropicTools2;
  return provider;
}
var bedrock = createAmazonBedrock();
export {
  VERSION,
  bedrock,
  createAmazonBedrock
};
//# sourceMappingURL=index.mjs.map