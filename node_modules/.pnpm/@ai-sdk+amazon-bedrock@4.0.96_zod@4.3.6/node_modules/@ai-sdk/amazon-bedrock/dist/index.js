"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  VERSION: () => VERSION,
  bedrock: () => bedrock,
  createAmazonBedrock: () => createAmazonBedrock
});
module.exports = __toCommonJS(index_exports);

// src/bedrock-provider.ts
var import_internal2 = require("@ai-sdk/anthropic/internal");
var import_provider_utils11 = require("@ai-sdk/provider-utils");

// src/bedrock-chat-language-model.ts
var import_provider_utils4 = require("@ai-sdk/provider-utils");
var import_v43 = require("zod/v4");

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
var import_v4 = require("zod/v4");
var bedrockFilePartProviderOptions = import_v4.z.object({
  /**
   * Citation configuration for this document.
   * When enabled, this document will generate citations in the response.
   */
  citations: import_v4.z.object({
    /**
     * Enable citations for this document
     */
    enabled: import_v4.z.boolean()
  }).optional()
});
var amazonBedrockLanguageModelOptions = import_v4.z.object({
  /**
   * Additional inference parameters that the model supports,
   * beyond the base set of inference parameters that Converse
   * supports in the inferenceConfig field
   */
  additionalModelRequestFields: import_v4.z.record(import_v4.z.string(), import_v4.z.any()).optional(),
  reasoningConfig: import_v4.z.object({
    type: import_v4.z.union([
      import_v4.z.literal("enabled"),
      import_v4.z.literal("disabled"),
      import_v4.z.literal("adaptive")
    ]).optional(),
    budgetTokens: import_v4.z.number().optional(),
    maxReasoningEffort: import_v4.z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    display: import_v4.z.enum(["omitted", "summarized"]).optional()
  }).optional(),
  /**
   * Anthropic beta features to enable
   */
  anthropicBeta: import_v4.z.array(import_v4.z.string()).optional(),
  /**
   * Service tier for the request.
   * @see https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html
   *
   * - 'reserved': Uses provisioned throughput capacity
   * - 'priority': Prioritizes low-latency inference when capacity is available
   * - 'default': Standard on-demand tier
   * - 'flex': Lower-cost tier for flexible latency workloads
   */
  serviceTier: import_v4.z.enum(["reserved", "priority", "default", "flex"]).optional()
});

// src/bedrock-error.ts
var import_v42 = require("zod/v4");
var BedrockErrorSchema = import_v42.z.object({
  message: import_v42.z.string(),
  type: import_v42.z.string().nullish()
});

// src/bedrock-event-stream-response-handler.ts
var import_provider = require("@ai-sdk/provider");
var import_provider_utils = require("@ai-sdk/provider-utils");

// src/bedrock-event-stream-decoder.ts
var import_eventstream_codec = require("@smithy/eventstream-codec");
var import_util_utf8 = require("@smithy/util-utf8");
function createBedrockEventStreamDecoder(body, processEvent) {
  const codec = new import_eventstream_codec.EventStreamCodec(import_util_utf8.toUtf8, import_util_utf8.fromUtf8);
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
  const responseHeaders = (0, import_provider_utils.extractResponseHeaders)(response);
  if (response.body == null) {
    throw new import_provider.EmptyResponseBodyError({});
  }
  return {
    responseHeaders,
    value: createBedrockEventStreamDecoder(
      response.body,
      async (event, controller) => {
        if (event.messageType === "event") {
          const parsedDataResult = await (0, import_provider_utils.safeParseJSON)({ text: event.data });
          if (!parsedDataResult.success) {
            controller.enqueue(parsedDataResult);
            return;
          }
          delete parsedDataResult.value.p;
          const wrappedData = {
            [event.eventType]: parsedDataResult.value
          };
          const validatedWrappedData = await (0, import_provider_utils.safeValidateTypes)({
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
var import_provider2 = require("@ai-sdk/provider");
var import_provider_utils2 = require("@ai-sdk/provider-utils");
var import_internal = require("@ai-sdk/anthropic/internal");
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
    } = await (0, import_internal.prepareTools)({
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
      const toolFactory = Object.values(import_internal.anthropicTools).find((factory) => {
        const instance = factory({});
        return instance.id === tool.id;
      });
      if (toolFactory != null) {
        const fullToolDefinition = toolFactory({});
        bedrockTools.push({
          toolSpec: {
            name: tool.name,
            inputSchema: {
              json: await (0, import_provider_utils2.asSchema)(fullToolDefinition.inputSchema).jsonSchema
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
        throw new import_provider2.UnsupportedFunctionalityError({
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
var import_provider3 = require("@ai-sdk/provider");
var import_provider_utils3 = require("@ai-sdk/provider-utils");

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
  const bedrockOptions = await (0, import_provider_utils3.parseProviderOptions)({
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
          throw new import_provider3.UnsupportedFunctionalityError({
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
                      throw new import_provider3.UnsupportedFunctionalityError({
                        functionality: "File URL data"
                      });
                    }
                    if (part.mediaType.startsWith("image/")) {
                      bedrockContent.push({
                        image: {
                          format: getBedrockImageFormat(part.mediaType),
                          source: { bytes: (0, import_provider_utils3.convertToBase64)(part.data) }
                        }
                      });
                    } else {
                      if (!part.mediaType) {
                        throw new import_provider3.UnsupportedFunctionalityError({
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
                          name: part.filename ? (0, import_provider_utils3.stripFileExtension)(part.filename) : generateDocumentName(),
                          source: { bytes: (0, import_provider_utils3.convertToBase64)(part.data) },
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
                            throw new import_provider3.UnsupportedFunctionalityError({
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
                          throw new import_provider3.UnsupportedFunctionalityError({
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
                const reasoningMetadata = await (0, import_provider_utils3.parseProviderOptions)({
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
    throw new import_provider3.UnsupportedFunctionalityError({
      functionality: "image without mime type",
      message: "Image mime type is required in user message part content"
    });
  }
  const format = BEDROCK_IMAGE_MIME_TYPES[mimeType];
  if (!format) {
    throw new import_provider3.UnsupportedFunctionalityError({
      functionality: `image mime type: ${mimeType}`,
      message: `Unsupported image mime type: ${mimeType}, expected one of: ${Object.keys(BEDROCK_IMAGE_MIME_TYPES).join(", ")}`
    });
  }
  return format;
}
function getBedrockDocumentFormat(mimeType) {
  const format = BEDROCK_DOCUMENT_MIME_TYPES[mimeType];
  if (!format) {
    throw new import_provider3.UnsupportedFunctionalityError({
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
    const bedrockOptions = (_a = await (0, import_provider_utils4.parseProviderOptions)({
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
    return (0, import_provider_utils4.combineHeaders)(await (0, import_provider_utils4.resolve)(this.config.headers), headers);
  }
  async doGenerate(options) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
    const {
      command: args,
      warnings,
      usesJsonResponseTool
    } = await this.getArgs(options);
    const url = `${this.getUrl(this.modelId)}/converse`;
    const { value: response, responseHeaders } = await (0, import_provider_utils4.postJsonToApi)({
      url,
      headers: await this.getHeaders({ headers: options.headers }),
      body: args,
      failedResponseHandler: (0, import_provider_utils4.createJsonErrorResponseHandler)({
        errorSchema: BedrockErrorSchema,
        errorToMessage: (error) => {
          var _a2;
          return `${(_a2 = error.message) != null ? _a2 : "Unknown error"}`;
        }
      }),
      successfulResponseHandler: (0, import_provider_utils4.createJsonResponseHandler)(
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
    const { value: response, responseHeaders } = await (0, import_provider_utils4.postJsonToApi)({
      url,
      headers: await this.getHeaders({ headers: options.headers }),
      body: args,
      failedResponseHandler: (0, import_provider_utils4.createJsonErrorResponseHandler)({
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
var BedrockStopReasonSchema = import_v43.z.union([
  import_v43.z.enum(BEDROCK_STOP_REASONS),
  import_v43.z.string()
]);
var BedrockAdditionalModelResponseFieldsSchema = import_v43.z.object({
  delta: import_v43.z.object({
    stop_sequence: import_v43.z.string().nullish()
  }).nullish()
}).catchall(import_v43.z.unknown());
var BedrockToolUseSchema = import_v43.z.object({
  toolUseId: import_v43.z.string(),
  name: import_v43.z.string(),
  input: import_v43.z.unknown()
});
var BedrockReasoningTextSchema = import_v43.z.object({
  signature: import_v43.z.string().nullish(),
  text: import_v43.z.string()
});
var BedrockRedactedReasoningSchema = import_v43.z.object({
  data: import_v43.z.string()
});
var BedrockResponseSchema = import_v43.z.object({
  metrics: import_v43.z.object({
    latencyMs: import_v43.z.number()
  }).nullish(),
  output: import_v43.z.object({
    message: import_v43.z.object({
      content: import_v43.z.array(
        import_v43.z.object({
          text: import_v43.z.string().nullish(),
          toolUse: BedrockToolUseSchema.nullish(),
          reasoningContent: import_v43.z.union([
            import_v43.z.object({
              reasoningText: BedrockReasoningTextSchema
            }),
            import_v43.z.object({
              redactedReasoning: BedrockRedactedReasoningSchema
            })
          ]).nullish()
        })
      ),
      role: import_v43.z.string()
    })
  }),
  stopReason: BedrockStopReasonSchema,
  additionalModelResponseFields: BedrockAdditionalModelResponseFieldsSchema.nullish(),
  trace: import_v43.z.unknown().nullish(),
  performanceConfig: import_v43.z.object({ latency: import_v43.z.string() }).nullish(),
  serviceTier: import_v43.z.object({ type: import_v43.z.string() }).nullish(),
  usage: import_v43.z.object({
    inputTokens: import_v43.z.number(),
    outputTokens: import_v43.z.number(),
    totalTokens: import_v43.z.number(),
    cacheReadInputTokens: import_v43.z.number().nullish(),
    cacheWriteInputTokens: import_v43.z.number().nullish(),
    cacheDetails: import_v43.z.array(import_v43.z.object({ inputTokens: import_v43.z.number(), ttl: import_v43.z.string() })).nullish()
  })
});
var BedrockStreamSchema = import_v43.z.object({
  contentBlockDelta: import_v43.z.object({
    contentBlockIndex: import_v43.z.number(),
    delta: import_v43.z.union([
      import_v43.z.object({ text: import_v43.z.string() }),
      import_v43.z.object({ toolUse: import_v43.z.object({ input: import_v43.z.string() }) }),
      import_v43.z.object({
        reasoningContent: import_v43.z.object({ text: import_v43.z.string() })
      }),
      import_v43.z.object({
        reasoningContent: import_v43.z.object({
          signature: import_v43.z.string()
        })
      }),
      import_v43.z.object({
        reasoningContent: import_v43.z.object({ data: import_v43.z.string() })
      })
    ]).nullish()
  }).nullish(),
  contentBlockStart: import_v43.z.object({
    contentBlockIndex: import_v43.z.number(),
    start: import_v43.z.object({
      toolUse: BedrockToolUseSchema.nullish()
    }).nullish()
  }).nullish(),
  contentBlockStop: import_v43.z.object({
    contentBlockIndex: import_v43.z.number()
  }).nullish(),
  internalServerException: import_v43.z.record(import_v43.z.string(), import_v43.z.unknown()).nullish(),
  messageStop: import_v43.z.object({
    additionalModelResponseFields: BedrockAdditionalModelResponseFieldsSchema.nullish(),
    stopReason: BedrockStopReasonSchema
  }).nullish(),
  metadata: import_v43.z.object({
    trace: import_v43.z.unknown().nullish(),
    performanceConfig: import_v43.z.object({ latency: import_v43.z.string() }).nullish(),
    serviceTier: import_v43.z.object({ type: import_v43.z.string() }).nullish(),
    usage: import_v43.z.object({
      cacheReadInputTokens: import_v43.z.number().nullish(),
      cacheWriteInputTokens: import_v43.z.number().nullish(),
      cacheDetails: import_v43.z.array(import_v43.z.object({ inputTokens: import_v43.z.number(), ttl: import_v43.z.string() })).nullish(),
      inputTokens: import_v43.z.number(),
      outputTokens: import_v43.z.number()
    }).nullish()
  }).nullish(),
  modelStreamErrorException: import_v43.z.record(import_v43.z.string(), import_v43.z.unknown()).nullish(),
  throttlingException: import_v43.z.record(import_v43.z.string(), import_v43.z.unknown()).nullish(),
  validationException: import_v43.z.record(import_v43.z.string(), import_v43.z.unknown()).nullish()
});
var bedrockReasoningMetadataSchema = import_v43.z.object({
  signature: import_v43.z.string().optional(),
  redactedData: import_v43.z.string().optional()
});

// src/bedrock-embedding-model.ts
var import_provider4 = require("@ai-sdk/provider");
var import_provider_utils5 = require("@ai-sdk/provider-utils");

// src/bedrock-embedding-options.ts
var import_v44 = require("zod/v4");
var amazonBedrockEmbeddingModelOptionsSchema = import_v44.z.object({
  /**
   * The number of dimensions the resulting output embeddings should have (defaults to 1024).
   * Only supported in amazon.titan-embed-text-v2:0.
   */
  dimensions: import_v44.z.union([import_v44.z.literal(1024), import_v44.z.literal(512), import_v44.z.literal(256)]).optional(),
  /**
   * Flag indicating whether or not to normalize the output embeddings. Defaults to true.
   * Only supported in amazon.titan-embed-text-v2:0.
   */
  normalize: import_v44.z.boolean().optional(),
  /**
   * The number of dimensions for Nova embedding models (defaults to 1024).
   * Supported values: 256, 384, 1024, 3072.
   * Only supported in amazon.nova-* embedding models.
   */
  embeddingDimension: import_v44.z.union([import_v44.z.literal(256), import_v44.z.literal(384), import_v44.z.literal(1024), import_v44.z.literal(3072)]).optional(),
  /**
   * The purpose of the embedding. Defaults to 'GENERIC_INDEX'.
   * Only supported in amazon.nova-* embedding models.
   */
  embeddingPurpose: import_v44.z.enum([
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
  inputType: import_v44.z.enum(["search_document", "search_query", "classification", "clustering"]).optional(),
  /**
   * Truncation behavior when input exceeds the model's context length.
   * Supported in Cohere and Nova embedding models. Defaults to 'END' for Nova models.
   */
  truncate: import_v44.z.enum(["NONE", "START", "END"]).optional(),
  /**
   * The number of dimensions the resulting output embeddings should have (defaults to 1536).
   * Only supported in cohere.embed-v4:0 and newer Cohere embedding models.
   */
  outputDimension: import_v44.z.union([import_v44.z.literal(256), import_v44.z.literal(512), import_v44.z.literal(1024), import_v44.z.literal(1536)]).optional()
});

// src/bedrock-embedding-model.ts
var import_v45 = require("zod/v4");
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
      throw new import_provider4.TooManyEmbeddingValuesForCallError({
        provider: this.provider,
        modelId: this.modelId,
        maxEmbeddingsPerCall: this.maxEmbeddingsPerCall,
        values
      });
    }
    const bedrockOptions = (_a = await (0, import_provider_utils5.parseProviderOptions)({
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
    const { value: response } = await (0, import_provider_utils5.postJsonToApi)({
      url,
      headers: await (0, import_provider_utils5.resolve)(
        (0, import_provider_utils5.combineHeaders)(await (0, import_provider_utils5.resolve)(this.config.headers), headers)
      ),
      body: args,
      failedResponseHandler: (0, import_provider_utils5.createJsonErrorResponseHandler)({
        errorSchema: BedrockErrorSchema,
        errorToMessage: (error) => `${error.type}: ${error.message}`
      }),
      successfulResponseHandler: (0, import_provider_utils5.createJsonResponseHandler)(
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
var BedrockEmbeddingResponseSchema = import_v45.z.union([
  // Titan-style response
  import_v45.z.object({
    embedding: import_v45.z.array(import_v45.z.number()),
    inputTextTokenCount: import_v45.z.number()
  }),
  // Nova-style response
  import_v45.z.object({
    embeddings: import_v45.z.array(
      import_v45.z.object({
        embeddingType: import_v45.z.string(),
        embedding: import_v45.z.array(import_v45.z.number())
      })
    ),
    inputTokenCount: import_v45.z.number().optional()
  }),
  // Cohere v3-style response
  import_v45.z.object({
    embeddings: import_v45.z.array(import_v45.z.array(import_v45.z.number()))
  }),
  // Cohere v4-style response
  import_v45.z.object({
    embeddings: import_v45.z.object({
      float: import_v45.z.array(import_v45.z.array(import_v45.z.number()))
    })
  })
]);

// src/bedrock-image-model.ts
var import_provider_utils6 = require("@ai-sdk/provider-utils");

// src/bedrock-image-settings.ts
var modelMaxImagesPerCall = {
  "amazon.nova-canvas-v1:0": 5
};

// src/bedrock-image-model.ts
var import_v46 = require("zod/v4");
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
    const { value: response, responseHeaders } = await (0, import_provider_utils6.postJsonToApi)({
      url: this.getUrl(this.modelId),
      headers: await (0, import_provider_utils6.resolve)(
        (0, import_provider_utils6.combineHeaders)(await (0, import_provider_utils6.resolve)(this.config.headers), headers)
      ),
      body: args,
      failedResponseHandler: (0, import_provider_utils6.createJsonErrorResponseHandler)({
        errorSchema: BedrockErrorSchema,
        errorToMessage: (error) => `${error.type}: ${error.message}`
      }),
      successfulResponseHandler: (0, import_provider_utils6.createJsonResponseHandler)(
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
    return (0, import_provider_utils6.convertUint8ArrayToBase64)(file.data);
  }
  return file.data;
}
var bedrockImageResponseSchema = import_v46.z.object({
  // Normal successful response
  images: import_v46.z.array(import_v46.z.string()).optional(),
  // Moderation response fields
  id: import_v46.z.string().optional(),
  status: import_v46.z.string().optional(),
  result: import_v46.z.unknown().optional(),
  progress: import_v46.z.unknown().optional(),
  details: import_v46.z.record(import_v46.z.string(), import_v46.z.unknown()).optional(),
  preview: import_v46.z.unknown().optional()
});

// src/bedrock-sigv4-fetch.ts
var import_provider_utils7 = require("@ai-sdk/provider-utils");
var import_aws4fetch = require("aws4fetch");

// src/version.ts
var VERSION = true ? "4.0.96" : "0.0.0-test";

// src/bedrock-sigv4-fetch.ts
function createSigV4FetchFunction(getCredentials, fetch = globalThis.fetch) {
  return async (input, init) => {
    var _a, _b;
    const request = input instanceof Request ? input : void 0;
    const originalHeaders = (0, import_provider_utils7.combineHeaders)(
      (0, import_provider_utils7.normalizeHeaders)(request == null ? void 0 : request.headers),
      (0, import_provider_utils7.normalizeHeaders)(init == null ? void 0 : init.headers)
    );
    const headersWithUserAgent = (0, import_provider_utils7.withUserAgentSuffix)(
      originalHeaders,
      `ai-sdk/amazon-bedrock/${VERSION}`,
      (0, import_provider_utils7.getRuntimeEnvironmentUserAgent)()
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
    const signer = new import_aws4fetch.AwsV4Signer({
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
    const signedHeaders = (0, import_provider_utils7.normalizeHeaders)(signingResult.headers);
    const combinedHeaders = (0, import_provider_utils7.combineHeaders)(headersWithUserAgent, signedHeaders);
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
    const originalHeaders = (0, import_provider_utils7.normalizeHeaders)(init == null ? void 0 : init.headers);
    const headersWithUserAgent = (0, import_provider_utils7.withUserAgentSuffix)(
      originalHeaders,
      `ai-sdk/amazon-bedrock/${VERSION}`,
      (0, import_provider_utils7.getRuntimeEnvironmentUserAgent)()
    );
    const finalHeaders = (0, import_provider_utils7.combineHeaders)(headersWithUserAgent, {
      Authorization: `Bearer ${apiKey}`
    });
    return fetch(input, {
      ...init,
      headers: finalHeaders
    });
  };
}

// src/reranking/bedrock-reranking-model.ts
var import_provider_utils10 = require("@ai-sdk/provider-utils");

// src/reranking/bedrock-reranking-api.ts
var import_provider_utils8 = require("@ai-sdk/provider-utils");
var import_v47 = require("zod/v4");
var bedrockRerankingResponseSchema = (0, import_provider_utils8.lazySchema)(
  () => (0, import_provider_utils8.zodSchema)(
    import_v47.z.object({
      results: import_v47.z.array(
        import_v47.z.object({
          index: import_v47.z.number(),
          relevanceScore: import_v47.z.number()
        })
      ),
      nextToken: import_v47.z.string().optional()
    })
  )
);

// src/reranking/bedrock-reranking-options.ts
var import_provider_utils9 = require("@ai-sdk/provider-utils");
var import_v48 = require("zod/v4");
var amazonBedrockRerankingModelOptionsSchema = (0, import_provider_utils9.lazySchema)(
  () => (0, import_provider_utils9.zodSchema)(
    import_v48.z.object({
      /**
       * If the total number of results was greater than could fit in a response, a token is returned in the nextToken field. You can enter that token in this field to return the next batch of results.
       */
      nextToken: import_v48.z.string().optional(),
      /**
       * Additional model request fields to pass to the model.
       */
      additionalModelRequestFields: import_v48.z.record(import_v48.z.string(), import_v48.z.any()).optional()
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
    const bedrockOptions = await (0, import_provider_utils10.parseProviderOptions)({
      provider: "bedrock",
      providerOptions,
      schema: amazonBedrockRerankingModelOptionsSchema
    });
    const {
      value: response,
      responseHeaders,
      rawValue
    } = await (0, import_provider_utils10.postJsonToApi)({
      url: `${this.config.baseUrl()}/rerank`,
      headers: await (0, import_provider_utils10.resolve)(
        (0, import_provider_utils10.combineHeaders)(await (0, import_provider_utils10.resolve)(this.config.headers), headers)
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
      failedResponseHandler: (0, import_provider_utils10.createJsonErrorResponseHandler)({
        errorSchema: BedrockErrorSchema,
        errorToMessage: (error) => `${error.type}: ${error.message}`
      }),
      successfulResponseHandler: (0, import_provider_utils10.createJsonResponseHandler)(
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
  const rawApiKey = (0, import_provider_utils11.loadOptionalSetting)({
    settingValue: options.apiKey,
    environmentVariableName: "AWS_BEARER_TOKEN_BEDROCK"
  });
  const apiKey = rawApiKey && rawApiKey.trim().length > 0 ? rawApiKey.trim() : void 0;
  const fetchFunction = apiKey ? createApiKeyFetchFunction(apiKey, options.fetch) : createSigV4FetchFunction(async () => {
    const region = (0, import_provider_utils11.loadSetting)({
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
        accessKeyId: (0, import_provider_utils11.loadSetting)({
          settingValue: options.accessKeyId,
          settingName: "accessKeyId",
          environmentVariableName: "AWS_ACCESS_KEY_ID",
          description: "AWS access key ID"
        }),
        secretAccessKey: (0, import_provider_utils11.loadSetting)({
          settingValue: options.secretAccessKey,
          settingName: "secretAccessKey",
          environmentVariableName: "AWS_SECRET_ACCESS_KEY",
          description: "AWS secret access key"
        }),
        sessionToken: (0, import_provider_utils11.loadOptionalSetting)({
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
    return (0, import_provider_utils11.withUserAgentSuffix)(baseHeaders, `ai-sdk/amazon-bedrock/${VERSION}`);
  };
  const getBedrockRuntimeBaseUrl = () => {
    var _a, _b;
    return (_b = (0, import_provider_utils11.withoutTrailingSlash)(
      (_a = options.baseURL) != null ? _a : `https://bedrock-runtime.${(0, import_provider_utils11.loadSetting)({
        settingValue: options.region,
        settingName: "region",
        environmentVariableName: "AWS_REGION",
        description: "AWS region"
      })}.amazonaws.com`
    )) != null ? _b : `https://bedrock-runtime.us-east-1.amazonaws.com`;
  };
  const getBedrockAgentRuntimeBaseUrl = () => {
    var _a, _b;
    return (_b = (0, import_provider_utils11.withoutTrailingSlash)(
      (_a = options.baseURL) != null ? _a : `https://bedrock-agent-runtime.${(0, import_provider_utils11.loadSetting)({
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
    generateId: import_provider_utils11.generateId
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
    region: (0, import_provider_utils11.loadSetting)({
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
  provider.tools = import_internal2.anthropicTools;
  return provider;
}
var bedrock = createAmazonBedrock();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  VERSION,
  bedrock,
  createAmazonBedrock
});
//# sourceMappingURL=index.js.map