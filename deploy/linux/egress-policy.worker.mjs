export default {
  async fetch(request,env) {
    const url=new URL(request.url),allowed=JSON.parse(env.ALLOWED_ORIGINS);
    if(!Array.isArray(allowed) || !allowed.includes(url.origin) || url.protocol!=="https:" || url.username || url.password)
      return Response.json({error:"unconfigured_external_dependency"},{status:503});
    // No redirects to an origin outside this exact owner-approved set.
    return fetch(request,{redirect:"manual"});
  }
};

