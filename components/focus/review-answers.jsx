'use client';

import { useState } from 'react';
import { CircleHelp, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function ReviewAnswers({ questions, disabled, onSend }) {
  const [values, setValues] = useState(() => questions.map(() => ''));
  const blank = values.every((value) => !value.trim());
  const send = async () => {
    await onSend(
      questions.map((question, index) => ({
        question,
        answer: values[index] || '',
      })),
    );
    setValues(questions.map(() => ''));
  };
  return (
    <div className="review-questions">
      <h3>
        <CircleHelp size={15} />A little clarity from you
      </h3>
      {questions.map((question, index) => (
        <div key={index} className="mt-3 flex flex-col gap-1.5">
          <p>
            <span>{index + 1}.</span>
            {question}
          </p>
          <Textarea
            size="sm"
            rows={2}
            aria-label={`Answer to question ${index + 1}`}
            placeholder="Your answer, or leave blank to skip"
            value={values[index] || ''}
            disabled={disabled}
            onChange={(event) =>
              setValues(
                values.map((value, i) =>
                  i === index ? event.target.value : value,
                ),
              )
            }
          />
        </div>
      ))}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="muted-caption">
          Your answers start a follow-up review.
        </span>
        <Button size="sm" disabled={disabled || blank} onClick={send}>
          <Send />
          Send answers
        </Button>
      </div>
    </div>
  );
}
