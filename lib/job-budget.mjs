import {AsyncLocalStorage} from 'node:async_hooks';
const budget=new AsyncLocalStorage();
export function withJobBudget(milliseconds,work){return budget.run(Date.now()+milliseconds,work);}
export function checkJobBudget(extra=0){const deadline=budget.getStore();if(deadline&&Date.now()+extra+1000>=deadline)throw Object.assign(Error('Continue in the next worker invocation.'),{yieldJob:true});return deadline?deadline-Date.now():Infinity;}
