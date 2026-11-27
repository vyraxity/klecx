"use client";

import { ReadAloudButton } from "@/components/speech/read-aloud-button";
import type { SpeechTarget } from "@/lib/schemas/speech";
import * as React from "react";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Markdown, type MarkdownVariant } from "@/components/markdown";
import { ThinkingPanel } from "./thinking-panel";
import { SourcesAccordion } from "./citations";
import { AnnotationLayer } from "@/components/annotations/annotation-layer";
import type { CitationDto } from "@/lib/api/sse";
import type { QuickFixContext } from "@/components/annotations/quick-fix";
import type { AnnotationItem } from "@/components/annotations/types";

export interface AnswerBodyProps {
  content: string;
  thoughtSummary?: string | null;
  citations?: CitationDto[] | null;
  /** The text is still being written: it can't be annotated or copied yet. */
  isStreaming?: boolean;
  /** What a highlight inside this text is anchored to. */
  targetType: "RESPONSE_VERSION" | "ANNOTATION_MESSAGE" | "DOCUMENT_REVISION";
  /** Id of the version / message / revision. Without it the text is not annotatable. */
  targetId?: string;
  /** Depth of annotations made on this text (0 = main response). */
  depth?: number;
  workspaceId?: string;
  responseId?: string;
  documentId?: string;
  documentRevision?: number;
  contentSource?: "ORIGINAL" | "EDIT";
  editRevision?: number;
  showCopyButton?: boolean;
  /**
   * Step 9.4: show "Read aloud" under the text. On by default for Ask answers
   * and generated documents; a main response has it in its own toolbar, so a
   * RESPONSE_VERSION shows it only when asked (uploaded documents).
   */
  showReadAloud?: boolean;
  /** "document" for the text of an uploaded document (see Markdown). */
  variant?: MarkdownVariant;
  /** The text review fixes are applied to (see AnnotationLayer). */
  quickFix?: QuickFixContext;
  onAnnotationsChange?: (annotations: AnnotationItem[]) => void;
  /**
   * The text shown has unsaved changes. New highlights are checked against
   * the saved text, so Comment and Ask wait until the changes are saved.
   */
  unsaved?: boolean;
  className?: string;
  /** Extra content under the sources (e.g. generated documents). */
  children?: React.ReactNode;
}

/**
 * The body of an AI answer: thinking summary, Markdown text with its
 * annotations, sources and (optionally) a copy button. Shared by the main
 * response card and the Ask columns so both look and behave the same (F2.5).
 */
export function AnswerBody({
  content,
  thoughtSummary,
  citations,
  isStreaming = false,
  targetType,
  targetId,
  depth = 0,
  workspaceId,
  responseId,
  documentId,
  documentRevision,
  contentSource = "ORIGINAL",
  editRevision,
  showCopyButton = false,
  showReadAloud,
  variant,
  quickFix,
  onAnnotationsChange,
  unsaved = false,
  className,
  children,
}: AnswerBodyProps) {
  const t = useTranslations("Response");
  const [copied, setCopied] = React.useState(false);
  const sources = Array.isArray(citations) ? citations : [];
  const annotatable = Boolean(targetId) && !isStreaming;
  const isVersion = targetType === "RESPONSE_VERSION";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const text = <Markdown content={content} citations={sources} variant={variant} />;

  const readAloudTarget: SpeechTarget | null = !targetId || isStreaming || !content.trim()
    ? null
    : targetType === "ANNOTATION_MESSAGE"
      ? { type: "ANNOTATION_MESSAGE", id: targetId }
      : targetType === "DOCUMENT_REVISION"
        ? { type: "DOCUMENT_REVISION", id: documentId || targetId, ...(documentRevision !== undefined ? { revision: documentRevision } : {}) }
        : {
            type: "RESPONSE_VERSION",
            id: targetId,
            source: contentSource,
            ...(contentSource === "EDIT" && editRevision !== undefined ? { editRevision } : {}),
          };
  const readAloudOn = (showReadAloud ?? targetType !== "RESPONSE_VERSION") && readAloudTarget !== null && !unsaved;

  return (
    <div className={cn("space-y-3", className)}>
      {thoughtSummary && (
        <ThinkingPanel
          thoughtSummary={thoughtSummary}
          isStreaming={isStreaming && !content}
        />
      )}

      {annotatable ? (
        <div
          className="leading-relaxed select-text"
          data-annot-root="true"
          data-annot-target-type={targetType}
          data-annot-target-id={targetId}
          data-annot-depth={depth}
          data-workspace-id={workspaceId}
          data-response-id={responseId}
          data-version-id={isVersion ? targetId : undefined}
          data-document-id={targetType === "DOCUMENT_REVISION" ? (documentId || targetId) : undefined}
          data-document-revision={
            targetType === "DOCUMENT_REVISION" && documentRevision !== undefined
              ? String(documentRevision)
              : undefined
          }
          data-content-source={isVersion ? contentSource : undefined}
          data-edit-revision={
            isVersion && editRevision !== undefined ? String(editRevision) : undefined
          }
          data-annot-unsaved={unsaved ? "true" : undefined}
        >
          <AnnotationLayer
            responseId={isVersion ? responseId : undefined}
            versionId={isVersion ? targetId : undefined}
            messageId={targetType === "ANNOTATION_MESSAGE" ? targetId : undefined}
            documentId={
              targetType === "DOCUMENT_REVISION" ? (documentId || targetId) : undefined
            }
            documentRevision={
              targetType === "DOCUMENT_REVISION" ? documentRevision : undefined
            }
            content={content}
            quickFix={quickFix}
            onAnnotationsChange={onAnnotationsChange}
          >
            {text}
          </AnnotationLayer>
        </div>
      ) : (
        <div className="leading-relaxed" aria-live="off">
          {text}
        </div>
      )}

      {sources.length > 0 && (
        <SourcesAccordion citations={sources} label={t("sources")} />
      )}

      {children}

      {((showCopyButton && content && !isStreaming) || readAloudOn) && (
        <div className="flex flex-wrap items-center justify-end gap-1" data-annot-ignore="true">
          {readAloudOn && readAloudTarget && <ReadAloudButton target={readAloudTarget} />}
          {showCopyButton && content && !isStreaming && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="text-muted hover:text-foreground h-7 px-2 text-xs"
          >
            {copied ? (
              <Check className="text-accent me-1 h-3.5 w-3.5" />
            ) : (
              <Copy className="me-1 h-3.5 w-3.5" />
            )}
            <span>{copied ? t("copied") : t("copy")}</span>
          </Button>
          )}
        </div>
      )}
    </div>
  );
}
