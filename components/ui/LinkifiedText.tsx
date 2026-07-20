import { Fragment } from "react";
import { splitLinks } from "@/lib/posts/linkify";

interface Props {
  text: string;
}

/**
 * Renders text with its URLs as links, leaving the text itself untouched.
 *
 * Inline only — the caller supplies the wrapping element and its styling, so
 * dropping this in place of `{text}` changes nothing about the layout.
 *
 * The links inherit their colour and carry no underline at rest: a post card is
 * a preview of copy, and a row of blue underlined URLs would read as chrome
 * rather than as the post. The underline appears on hover and on keyboard focus,
 * which is where the affordance is actually needed.
 */
export function LinkifiedText({ text }: Props) {
  return (
    <>
      {splitLinks(text).map((segment, i) =>
        segment.type === "url" ? (
          <a
            key={i}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:underline focus-visible:underline"
          >
            {segment.value}
          </a>
        ) : (
          <Fragment key={i}>{segment.value}</Fragment>
        )
      )}
    </>
  );
}
