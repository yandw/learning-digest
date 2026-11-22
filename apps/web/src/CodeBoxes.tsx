import { useRef, useState } from "react";

/**
 * 6-digit one-time-code entry (Figma W04): six 44×52 boxes driven by a
 * single invisible input overlaying the row. Typing, paste and Backspace
 * all flow through the one input; the boxes mirror its value, with the
 * active box following the caret position.
 */
export default function CodeBoxes({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  id?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const digits = Array.from({ length: 6 }, (_, index) => value[index] || "");
  const activeIndex = focused && value.length < 6 ? value.length : -1;

  return (
    <div className="otp-row" onClick={() => inputRef.current?.focus()}>
      {digits.map((digit, index) => (
        <div
          // Boxes are presentational; the labelled input below owns the value.
          aria-hidden="true"
          key={index}
          className={`otp-box${digit ? " filled" : ""}${
            index === activeIndex ? " active" : ""
          }`}
        >
          {digit}
        </div>
      ))}
      <input
        ref={inputRef}
        id={id}
        className="otp-hidden"
        aria-label="验证码"
        value={value}
        inputMode="numeric"
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={6}
        autoFocus
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </div>
  );
}
