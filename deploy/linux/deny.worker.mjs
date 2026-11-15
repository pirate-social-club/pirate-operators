export default {
  fetch(){return Response.json({error:"external_dependency_unavailable"},{status:503});}
};
