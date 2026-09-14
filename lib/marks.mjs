export const MARK_START='\uE000';
export const MARK_END='\uE001';
export function stripMarks(text){return text.replace(new RegExp('['+MARK_START+MARK_END+']','g'),'').replace(/^…|…$/g,'');}
