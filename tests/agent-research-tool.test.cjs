const test = require('node:test');
const assert = require('node:assert/strict');
const { createResearchTools } = require('../app/agent-tools');

test('search_research_findings tool queries research store and formats evidence', async () => {
  const fakeFindings = [
    {
      id: 'fnd-100',
      claim: 'FastAPI async lifespan optimization improves latency by 20%',
      quote: 'async Lifespan state optimization',
      status: 'promoted',
      targetProject: 'pi-hub',
      relevance: 'Direct Dependency'
    },
    {
      id: 'fnd-200',
      claim: 'Pydantic v2 serialization accelerates response formatting',
      quote: 'Pydantic v2 serialization performance',
      status: 'kept',
      targetProject: 'LocalAI',
      relevance: 'General'
    }
  ];

  const fakeStore = {
    listFindings: ({ limit }) => fakeFindings
  };

  const tools = createResearchTools({
    projectRoot: __dirname,
    projectId: 'test-proj',
    researchStore: fakeStore
  });

  const searchTool = tools.find(t => t.name === 'search_research_findings');
  assert.ok(searchTool, 'search_research_findings tool is defined');

  // Search by query
  const res = await searchTool.execute({ query: 'lifespan' });
  assert.equal(res.data.matches.length, 1);
  assert.equal(res.data.matches[0].id, 'fnd-100');
  assert.equal(res.evidence.length, 1);
  assert.equal(res.evidence[0].source, 'research:finding:fnd-100');

  // Search with project filter
  const resProj = await searchTool.execute({ query: 'pydantic', target_project: 'LocalAI' });
  assert.equal(resProj.data.matches.length, 1);
  assert.equal(resProj.data.matches[0].id, 'fnd-200');

  // Filter with non-matching project
  const resEmpty = await searchTool.execute({ query: 'pydantic', target_project: 'pi-hub' });
  assert.equal(resEmpty.data.matches.length, 0);
});
