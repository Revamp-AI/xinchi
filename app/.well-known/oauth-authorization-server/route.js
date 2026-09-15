import {authorizationMetadata} from '../../../lib/mcp-auth.mjs';
export const dynamic='force-dynamic';
export function GET(){return Response.json(authorizationMetadata(),{headers:{'Cache-Control':'public, max-age=300'}});}
