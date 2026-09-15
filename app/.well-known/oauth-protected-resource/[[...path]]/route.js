import {protectedResourceMetadata} from '../../../../lib/mcp-auth.mjs';
export const dynamic='force-dynamic';
export function GET(){return Response.json(protectedResourceMetadata(),{headers:{'Cache-Control':'public, max-age=300'}});}
