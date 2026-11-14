import { supabase } from '../lib/supabase';
import { logActivity } from '../lib/logActivity';

const API_URL = 'http://localhost:8000';

const detectJobCategory = (positionTitle) => {
  const title = (positionTitle || '').toLowerCase();

  if (/\b(it|information technology|developer|tech support)\b/.test(title)) return 'it';
  if (/\bengineer\b/.test(title)) return 'engineering';
  if (/\b(account|accounting|budget|finance|cashier|treasury)\b/.test(title)) return 'finance';
  if (/\b(building inspector|construction|foreman|inspector)\b/.test(title)) return 'construction';
  if (/\b(mechanic|technician|technical|automotive)\b/.test(title)) return 'technical';
  if (/\b(agriculture|veterinary|veterinarian|slaughterhouse|agriculturist)\b/.test(title)) return 'agriculture';
  if (/\b(sports|recreation)\b/.test(title)) return 'sports';
  if (/\b(planning|development officer|urban planner)\b/.test(title)) return 'planning';
  if (/\b(social worker|community affairs|social welfare)\b/.test(title)) return 'social_services';
  if (/\b(information officer|media|communication|journalism)\b/.test(title)) return 'communications';
  if (/\b(administrative|admin|clerk|secretary|office staff|administrative aide|administrative officer)\b/.test(title)) return 'administrative';

  return 'administrative';
};

const screenPDSWithAPI = async (pdsFile, job) => {
  let educationValue = job.required_education ?? 0;
  let experienceValue = job.required_work_experience ?? 0;
  let trainingValue = job.required_training ?? 0;
  const eligibilityValue = job.required_eligibility ?? 'none';

  if (educationValue === 'None Required' || educationValue === '' || educationValue === null) educationValue = 0;
  else educationValue = parseInt(educationValue) || 0;

  if (experienceValue === 'None Required' || experienceValue === '' || experienceValue === null) experienceValue = 0;
  else experienceValue = parseInt(experienceValue) || 0;

  if (trainingValue === 'None Required' || trainingValue === '' || trainingValue === null) trainingValue = 0;
  else trainingValue = parseInt(trainingValue) || 0;

  const formData = new FormData();
  formData.append('file', pdsFile);

  const params = new URLSearchParams({
    position_title: job.position_title || 'Position',
    job_category: detectJobCategory(job.position_title),
    education: educationValue,
    experience: experienceValue,
    training_hours: trainingValue,
    eligibility_level: eligibilityValue,
  });

  const response = await fetch(`${API_URL}/upload-pds?${params}`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error (${response.status}): ${errorText}`);
  }

  return await response.json();
};

/**
 * Re-upload any document for an application.
 * - docType: 'pds' | 'transcript' | 'performanceRating'
 * - Only 'pds' triggers re-screening (the score depends on PDS)
 */
export async function reassessApplication({ application, newFile, docType = 'pds' }) {
  // 1. Load the job
  const { data: job, error: jobError } = await supabase
    .from('job_postings')
    .select('*')
    .eq('id', application.job_id)
    .single();

  if (jobError) throw new Error(`Could not load job: ${jobError.message}`);

  // ✅ NEW: Delete the old file BEFORE uploading the new one
  const { data: existingFiles } = await supabase.storage
    .from('applicant_docs')
    .list(`${application.job_id}/${application.applicant_id}`);

  if (existingFiles && existingFiles.length > 0) {
    const type = docType.toLowerCase();
    const oldFiles = existingFiles.filter(f =>
      f.name.toLowerCase().startsWith(type)
    );

    if (oldFiles.length > 0) {
      const pathsToDelete = oldFiles.map(
        f => `${application.job_id}/${application.applicant_id}/${f.name}`
      );
      const { error: deleteError } = await supabase.storage
        .from('applicant_docs')
        .remove(pathsToDelete);

      if (deleteError) {
        console.warn('Could not delete old file:', deleteError);
        // Continue anyway — the upload will succeed
      }
    }
  }

  // 2. Upload file to storage
  const ext = newFile.name.split('.').pop();
  const prefix = docType;
  const filePath = `${application.job_id}/${application.applicant_id}/${prefix}-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('applicant_docs')
    .upload(filePath, newFile, { upsert: true });

  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  const { data: { publicUrl } } = supabase.storage
    .from('applicant_docs')
    .getPublicUrl(filePath);

  // 3. Build the update object
  const docFilenames = {
    ...(application.doc_filenames || {}),
    [docType]: publicUrl,
  };

  const docsSubmitted = {
    ...(application.docs_submitted || {}),
    [docType]: true,
  };

  const updatePayload = {
    doc_filenames: docFilenames,
    docs_submitted: docsSubmitted,
    updated_at: new Date().toISOString(),
  };

  // 4. Only PDS changes trigger re-screening
  let adjustedScore = application.ai_match_score;
  let oldScore = application.ai_match_score;

  if (docType === 'pds') {
    const screeningResult = await screenPDSWithAPI(newFile, job);
    if (!screeningResult.success) {
      throw new Error(screeningResult.error || 'Screening failed');
    }

    const rawScore = screeningResult.fit_analysis?.percentage || 0;
    const penalty = 3.2 + Math.random() * 0.2;
    adjustedScore = Math.max(0, Number((rawScore - penalty).toFixed(2)));

    const previousScores = [
      ...(application.ai_explanation?.previous_scores || []),
      { score: application.ai_match_score, at: new Date().toISOString() },
    ];

    updatePayload.ai_match_score = adjustedScore;
    updatePayload.ai_explanation = {
      verdict: screeningResult.fit_analysis?.verdict || 'NOT FIT',
      breakdown: screeningResult.fit_analysis?.breakdown || {},
      requirements_met: screeningResult.fit_analysis?.requirements_met || '0/0',
      score: adjustedScore,
      binary_percentage: screeningResult.fit_analysis?.binary_percentage || 0,
      summary: screeningResult.explanation?.summary || '',
      feature_breakdown: screeningResult.explanation?.feature_breakdown || [],
      recommendations: screeningResult.explanation?.recommendations || [],
      verdict_description: screeningResult.explanation?.verdict_description || '',
      previous_scores: previousScores,
    };
  }

  // 5. Save to DB
  const { error: updateError } = await supabase
    .from('applications')
    .update(updatePayload)
    .eq('id', application.id);

  if (updateError) throw new Error(`Update failed: ${updateError.message}`);

  // 6. Log
  const docLabel = docType === 'pds' ? 'PDS'
    : docType === 'transcript' ? 'Transcript'
    : 'Performance Rating';

  await logActivity(
    'status_update',
    docType === 'pds'
      ? `Re-assessed PDS for "${job.position_title}" — score ${oldScore}% → ${adjustedScore}%`
      : `Re-uploaded ${docLabel} for "${job.position_title}"`,
    { job_id: application.job_id, metadata: { application_id: application.id, doc_type: docType } }
  );

  // 7. Return
  return {
    oldScore: docType === 'pds' ? oldScore : null,
    newScore: docType === 'pds' ? adjustedScore : null,
    jobTitle: job.position_title,
    docType,
    updatedFilenames: docFilenames,
    updatedSubmitted: docsSubmitted,
  };
}