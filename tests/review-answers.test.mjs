import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'xin-review-answers-test-'));process.env.XIN_DATA_DIR=temp;
const {nonBlankAnswers,shouldClear}=await import('../lib/review-answers.mjs');
const questions=['Who owns the pricing checklist?','When is the launch review?','Is the onboarding doc final?'];
test('nonBlankAnswers pairs each question with its trimmed answer and drops blank ones',()=>{
 assert.deepEqual(nonBlankAnswers(questions,['  Morgan ','',' \n']),[{question:questions[0],answer:'Morgan'}]);
 assert.deepEqual(nonBlankAnswers(questions,['Morgan','Friday','Yes']),[{question:questions[0],answer:'Morgan'},{question:questions[1],answer:'Friday'},{question:questions[2],answer:'Yes'}]);
 assert.deepEqual(nonBlankAnswers(questions,[undefined,null,'Yes']),[{question:questions[2],answer:'Yes'}]);
 assert.deepEqual(nonBlankAnswers(questions,['','','']),[]);
 assert.deepEqual(nonBlankAnswers(questions,[]),[]);
 assert.deepEqual(nonBlankAnswers([],['stray']),[]);
});
test('typed answers are cleared only when the follow-up review actually started',()=>{
 assert.equal(shouldClear(true),true);
 assert.equal(shouldClear(false),false);
 assert.equal(shouldClear(undefined),false);
 assert.equal(shouldClear(null),false);
 assert.equal(shouldClear({id:'job-1'}),false);
});
test.after(()=>rmSync(temp,{recursive:true,force:true}));
