/** Explicit disposable local transport. The ordinary public egress worker is
 * unchanged. Actual application, signatures and remote handlers still execute. */
export default {
  async fetch(request:Request,env:{FIXTURE_ROUTES_JSON:string}){
    const routes=JSON.parse(env.FIXTURE_ROUTES_JSON) as Array<{origin:string;upstream:string}>;
    const url=new URL(request.url),route=routes.find(row=>row.origin===url.origin);
    if(!route || url.username || url.password)return new Response("Unconfigured fixture target",{status:503});
    const target=new URL(route.upstream);
    target.pathname+=url.pathname;target.search=url.search;
    return fetch(new Request(target,request),{redirect:"manual"});
  },
};
