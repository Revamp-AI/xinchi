export function nonBlankAnswers(questions,answers){return questions.map((question,i)=>({question,answer:String(answers[i]||'').trim()})).filter(a=>a.answer);}
export function shouldClear(result){return result===true;}
