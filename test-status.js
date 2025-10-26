import { RunwayService } from './runway';

const runwayService = new RunwayService();

async function testStatusCheck() {
  const generationId = 'f089a7c8-af5a-424c-abe6-3d601a5d3081';
  
  console.log('Testing status check for:', generationId);
  
  try {
    const status = await runwayService.checkJobStatus(generationId);
    console.log('Status result:', status);
  } catch (error) {
    console.error('Status check failed:', error);
  }
}

testStatusCheck();
