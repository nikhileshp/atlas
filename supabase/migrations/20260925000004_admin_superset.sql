-- Admin becomes a superset of pm. Originally admin could only write entities,
-- aliases, and invites; research writes were analyst/pm only. In a firm where
-- the same person runs the system and does the research, that split forced a
-- second account. Attribution is unchanged: every row still records the
-- acting user, and UPDATE/DELETE remain revoked for everyone.

alter policy artifact_insert on public.artifact
  with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm', 'admin')
  );

alter policy artifact_entity_insert on public.artifact_entity
  with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm', 'admin')
  );

alter policy quality_score_insert on public.quality_score
  with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm', 'admin')
  );

alter policy scenario_insert on public.scenario
  with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm', 'admin')
  );

alter policy position_input_insert on public.position_input
  with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('pm', 'admin')
  );

alter policy decision_insert on public.decision
  with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('pm', 'admin')
  );
