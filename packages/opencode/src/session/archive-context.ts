import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai"

import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"

function prefix(id: string, text: string) {
  return `[${id}] ${text}`
}

function archivePlaceholder(info: MessageV2.Info) {
  const archive = info.archive!
  const rangeLabel =
    archive.rangeEnd && archive.rangeEnd !== info.id
      ? `[SMART_ARCHIVED: ${info.id} to ${archive.rangeEnd}]`
      : `[SMART_ARCHIVED: ${info.id}]`
  return `${rangeLabel}\nSummary: ${archive.summary}\nIndex: ${archive.indexTerms.join(", ")}`
}

export function toModelMessageWithIDs(messages: MessageV2.WithParts[]): ModelMessage[] {
  const result: UIMessage[] = []

  for (const msg of messages) {
    if (msg.info.archive) {
      result.push({
        id: msg.info.id,
        role: msg.info.role as UIMessage["role"],
        parts: [
          {
            type: "text",
            text: prefix(msg.info.id, archivePlaceholder(msg.info)),
          },
        ],
      })
      continue
    }

    if (msg.info.archivedBy) continue
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      result.push(userMessage)

      for (const part of msg.parts) {
        if (part.type === "text" && !part.ignored) {
          userMessage.parts.push({
            type: "text",
            text: prefix(msg.info.id, part.text),
          })
        }
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          userMessage.parts.push({
            type: "file",
            url: part.url,
            mediaType: part.mime,
            filename: part.filename,
          })
        }
        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: prefix(msg.info.id, "What did we do so far?"),
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: prefix(msg.info.id, "The following tool was executed by the user"),
          })
        }
      }
    }

    if (msg.info.role === "assistant") {
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      result.push(assistantMessage)

      for (const part of msg.parts) {
        if (part.type === "text") {
          assistantMessage.parts.push({
            type: "text",
            text: prefix(msg.info.id, part.text),
            providerMetadata: part.metadata,
          })
        }

        if (part.type === "step-start") {
          assistantMessage.parts.push({
            type: "step-start",
          })
        }

        if (part.type === "tool") {
          if (part.state.status === "completed") {
            if (part.state.attachments?.length) {
              result.push({
                id: Identifier.ascending("message"),
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: prefix(msg.info.id, `Tool ${part.tool} returned an attachment [continued]:`),
                  },
                  ...part.state.attachments.map((attachment) => ({
                    type: "file" as const,
                    url: attachment.url,
                    mediaType: attachment.mime,
                    filename: attachment.filename,
                  })),
                ],
              })
            }
            assistantMessage.parts.push({
              type: (`tool-${part.tool}`) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output: part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output,
              callProviderMetadata: part.metadata,
            })
          } else if (part.state.status === "error") {
            assistantMessage.parts.push({
              type: (`tool-${part.tool}`) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: part.state.error,
              callProviderMetadata: part.metadata,
            })
          }
        }

        if (part.type === "reasoning") {
          assistantMessage.parts.push({
            type: "reasoning",
            text: prefix(msg.info.id, part.text),
            providerMetadata: part.metadata,
          })
        }

        if (part.type === "context-gauge") {
          assistantMessage.parts.push({
            type: "text",
            text: prefix(
              msg.info.id,
              `[CONTEXT GAUGE: ${part.tokenCount.toLocaleString()} / ${part.contextLimit.toLocaleString()} tokens (${part.percentage}%)]`,
            ),
          })
        }

        if (part.type === "patch") {
          assistantMessage.parts.push({
            type: "text",
            text: prefix(msg.info.id, `[PATCH ${part.hash}] ${part.files.join(", ")}`),
          })
        }

        if (part.type === "snapshot") {
          assistantMessage.parts.push({
            type: "text",
            text: prefix(msg.info.id, `[SNAPSHOT] ${part.snapshot}`),
          })
        }

        if (part.type === "agent") {
          assistantMessage.parts.push({
            type: "text",
            text: prefix(msg.info.id, `[AGENT ${part.name}]`),
          })
        }

        if (part.type === "retry") {
          assistantMessage.parts.push({
            type: "text",
            text: prefix(msg.info.id, `[RETRY attempt=${part.attempt}] ${JSON.stringify(part.error)}`),
          })
        }

        if (part.type === "step-finish") {
          assistantMessage.parts.push({
            type: "text",
            text: prefix(
              msg.info.id,
              `[STEP-FINISH reason=${part.reason}] cost=${part.cost} tokens: input=${part.tokens.input}, output=${part.tokens.output}`,
            ),
          })
        }
      }
    }
  }

  return convertToModelMessages(result.filter((msg) => msg.parts.length > 0))
}
