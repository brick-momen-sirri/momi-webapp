# Missing Data Report

Generated after inspecting:

- `comfyui_credit_tracker`
- `ComfyUI_CreditBadge_Momi`
- `comfyui_brick_tools`
- Brick workflow example JSON folders

## Summary

The current ComfyUI custom nodes provide useful project folder structure, workflow examples, Comfy prompt IDs, project names, estimated credits, and balance snapshots. They do not yet provide a complete user/team/project permission model or full frontend job lifecycle records. The new backend fills those gaps locally in `backend/data` while still saving jobs into the selected project folder structure.

## Fields

Field: user ID  
Status: missing  
Where found: Not present in `usage_log.db`; only `user_name` exists in `credit_usage`.  
Recommendation: Add `user_id` to job metadata and credit usage records.

Field: user name  
Status: available  
Where found: `usage_log.db` table `credit_usage.user_name`.  
Recommendation: Keep writing this, but pair it with stable `user_id`.

Field: user email  
Status: missing  
Where found: Not found in credit tracker or Brick saver metadata.  
Recommendation: Store local account email in backend job metadata.

Field: team name  
Status: missing  
Where found: Not found in inspected custom nodes.  
Recommendation: Add team fields to backend project/user records before reporting team spend.

Field: project ID  
Status: missing  
Where found: Brick uses folder names; credit tracker stores `project_name`.  
Recommendation: Store backend `projectId` in `metadata.json` and optionally in Brick saver metadata.

Field: project name  
Status: available  
Where found: `credit_usage.project_name`, Brick saver `project_name`, and `ComfyUI/output/projects/{project_name}`.  
Recommendation: Continue using the Brick folder name as the human-readable project name.

Field: project short name  
Status: available  
Where found: Derived by Brick tools from the first four digits in the project folder name.  
Recommendation: Persist the derived short code in backend project records.

Field: project folder path  
Status: available  
Where found: Brick tools save under `ComfyUI/output/projects/{project_name}`.  
Recommendation: Use this as primary save location; backend fallback is `backend/data/projects`.

Field: job ID  
Status: unclear  
Where found: ComfyUI has `prompt_id`; Brick manifest records saves, but no separate app job ID is guaranteed.  
Recommendation: Backend creates stable `job_*` IDs and stores the related Comfy prompt ID.

Field: ComfyUI prompt ID  
Status: available  
Where found: `credit_usage.prompt_id` and ComfyUI `/prompt` response.  
Recommendation: Store on every backend job and metadata file.

Field: model/workflow name  
Status: available  
Where found: `credit_usage.workflow_name`, `credit_usage.model_name`, and workflow filenames.  
Recommendation: Normalize workflow model names from `/api/models`.

Field: workflow file path  
Status: available  
Where found: Workflow JSON example folders.  
Recommendation: Store source path and per-job workflow snapshot path.

Field: prompt text  
Status: unclear  
Where found: Comfy workflow JSON can contain prompt fields, but credit tracker schema does not have a dedicated prompt text column.  
Recommendation: Store prompt text in backend `metadata.json`.

Field: input image paths  
Status: unclear  
Where found: Credit tracker has `input_summary`; Brick manifests focus on saved outputs.  
Recommendation: Store input paths/URLs in backend job metadata.

Field: output image/video paths  
Status: available  
Where found: Brick saves images, sequences, and videos under project folders; Comfy history returns output files.  
Recommendation: Store normalized output URLs and local paths after each job.

Field: thumbnail paths  
Status: unclear  
Where found: Brick browser creates cache thumbnails, but job-level thumbnail metadata is not guaranteed.  
Recommendation: Store thumbnail paths in backend metadata once generated.

Field: resolution  
Status: available  
Where found: `credit_usage.resolution`; workflows also include width/height nodes.  
Recommendation: Keep backend `resolution` object with width, height, and label.

Field: generation status  
Status: unclear  
Where found: Auto tracker listens to execution events, but `credit_usage` is not a full job status table.  
Recommendation: Backend persists `queued`, `sending`, `running`, `completed`, `failed`, `canceled`.

Field: started time  
Status: unclear  
Where found: `credit_usage.timestamp` and internal tracker runtime events exist, but no guaranteed job-level startedAt.  
Recommendation: Backend stores `startedAt` when sending to ComfyUI.

Field: completed time  
Status: unclear  
Where found: Save manifests and credit rows have timestamps, but no dedicated completedAt field.  
Recommendation: Backend stores `completedAt` after history result is available.

Field: generation duration  
Status: available  
Where found: `credit_usage.duration_seconds`.  
Recommendation: Copy or calculate duration into backend metadata.

Field: estimated credits  
Status: available  
Where found: `credit_usage.estimated_credits`; backend model inference adds estimates when missing.  
Recommendation: Prefer tracker values when a prompt ID match is available.

Field: used credits  
Status: unclear  
Where found: `estimated_credits` is available; badge exposes remaining balance; actual used credits may be provider-specific.  
Recommendation: Add explicit `credits_used` after provider callback or tracker reconciliation.

Field: credits left after job  
Status: available  
Where found: `balance_snapshots.credits` and `ComfyUI_CreditBadge_Momi` `/abuomar_credit` route.  
Recommendation: Snapshot credits before and after backend job completion.

Field: error message  
Status: unclear  
Where found: ComfyUI execution can report errors; not present as a stable field in credit usage.  
Recommendation: Backend stores `errorMessage` on failed jobs.

Field: sharing permissions  
Status: missing  
Where found: Not present in inspected custom nodes.  
Recommendation: Keep this in the app backend project/member model.

Field: project members  
Status: missing  
Where found: Not present in Brick project folders or credit tracker.  
Recommendation: Persist backend project `members` and optionally add a project metadata file.

Field: team/group members  
Status: missing  
Where found: Not present in inspected custom nodes.  
Recommendation: Persist backend `groupMembers` and connect it to local/team auth later.

## Existing Project Media Scan

The backend now scans Brick project folders under `ComfyUI/output/projects/{project}/images`, `videos`, and `sequences`. If a media file has no matching `metadata/manifest.jsonl` record, it is still returned as a visible completed job with `source: existing_project_media` and a `Missing metadata` badge in the frontend.

Media file: existing images/videos/sequences without matching manifest rows  
Field: original input image  
Status: missing / unclear  
Recommendation: Add input image paths to Brick saver metadata or backend job metadata.

Media file: existing images/videos/sequences without matching manifest rows  
Field: thumbnail path  
Status: missing / unclear  
Recommendation: Generate or record thumbnails in project metadata; fallback uses the result image or first sequence frame.

Media file: existing images/videos/sequences without matching manifest rows  
Field: prompt  
Status: missing / unclear  
Recommendation: Preserve prompt text in `manifest.jsonl` or embedded media metadata.

Media file: existing images/videos/sequences without matching manifest rows  
Field: model name  
Status: missing / unclear  
Recommendation: Store `model_prefix` or workflow/model name for every save event.

Media file: existing images/videos/sequences without matching manifest rows  
Field: workflow path  
Status: missing / unclear  
Recommendation: Store workflow file path and workflow snapshot path in save metadata.

Media file: existing images/videos/sequences without matching manifest rows  
Field: resolution  
Status: missing / unclear  
Recommendation: Store width/height for image and sequence saves; video saves already log width/height when available.

Media file: existing images/videos/sequences without matching manifest rows  
Field: user name / user ID  
Status: missing / unclear  
Recommendation: Add authenticated app user fields to Brick save metadata.

Media file: existing images/videos/sequences without matching manifest rows  
Field: created date / completed date  
Status: available / fallback  
Recommendation: Use manifest `timestamp_utc` when available; fallback is filesystem modified time.

Media file: existing images/videos/sequences without matching manifest rows  
Field: generation duration  
Status: missing / unclear  
Recommendation: Record start/end times or duration in backend job metadata.

Media file: existing images/videos/sequences without matching manifest rows  
Field: credits used  
Status: missing / unclear  
Recommendation: Reconcile media files with `usage_log.db` by Comfy prompt ID or node ID.

Media file: existing images/videos/sequences without matching manifest rows  
Field: project ID / project short name  
Status: available / fallback  
Recommendation: Backend derives project ID and short name from the Brick folder name.

Media file: existing images/videos/sequences without matching manifest rows  
Field: job ID / ComfyUI prompt ID  
Status: missing / unclear  
Recommendation: Backend generates stable media IDs from file paths; store real Comfy prompt IDs in future save metadata.
