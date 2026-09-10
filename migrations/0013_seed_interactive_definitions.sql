-- =============================================================================
-- 0013_seed_interactive_definitions.sql
-- 內建互動元件定義
-- 依據：SD v1.1 §7.3.3（元件對照表）、§7.3.4（schema 範例）、ADR-024
-- 相依：0003
-- =============================================================================
-- server_evaluator 欄位是 ADR-024 的落實：每個元件的成績由指定的
-- server 端 evaluator 產生，client adapter 只負責 buildSubmitPayload()。
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- H5P 元件（透過 Adapter 使用，不成為核心 domain 相依；ADR-012）
-- H5P 的內建評分結果不直接寫入 learning_results，
-- 一律經 H5pXapiEvaluator 依 answer_key 重新確認（SD §7.4）。
-- --------------------------------------------------------------------------
INSERT INTO interactive_definitions
  (component_type, schema_version, display_name,
   config_schema, runtime_schema, result_schema, answer_key_schema,
   event_mapping, server_evaluator) VALUES

('h5p.interactive_video', '1.0', 'H5P 互動影片',
 '{"type":"object","required":["contentId"],"properties":{"contentId":{"type":"string"},"objectKey":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"contentId":{"type":"string"},"resumeState":{"type":"object"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"},"feedback_data":{"type":"object"}}}'::jsonb,
 '{"type":"object","properties":{"pass_threshold":{"type":"number"},"interaction_answers":{"type":"object"}}}'::jsonb,
 '{"attempted":"activity.started","interacted":"activity.input_changed","answered":"activity.submitted","completed":"activity.completed","played":"video.started","seeked":"video.progressed"}'::jsonb,
 'H5pXapiEvaluator'),

('h5p.multiple_choice', '1.0', 'H5P 單選題',
 '{"type":"object","required":["contentId"],"properties":{"contentId":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"contentId":{"type":"string"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"correct_choices":{"type":"array"},"pass_threshold":{"type":"number"}}}'::jsonb,
 '{"attempted":"activity.started","answered":"activity.submitted","completed":"activity.completed"}'::jsonb,
 'H5pXapiEvaluator'),

('h5p.fill_in_blanks', '1.0', 'H5P 填空題',
 '{"type":"object","required":["contentId"],"properties":{"contentId":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"contentId":{"type":"string"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"blanks":{"type":"array"},"case_sensitive":{"type":"boolean"}}}'::jsonb,
 '{"attempted":"activity.started","answered":"activity.submitted","completed":"activity.completed"}'::jsonb,
 'H5pXapiEvaluator'),

('h5p.drag_and_drop', '1.0', 'H5P 拖放題',
 '{"type":"object","required":["contentId"],"properties":{"contentId":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"contentId":{"type":"string"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"correct_pairs":{"type":"array"}}}'::jsonb,
 '{"attempted":"activity.started","answered":"activity.submitted","completed":"activity.completed"}'::jsonb,
 'H5pXapiEvaluator'),

('h5p.branching_scenario', '1.0', 'H5P 分支情境',
 '{"type":"object","required":["contentId"],"properties":{"contentId":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"contentId":{"type":"string"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"acceptable_endings":{"type":"array"}}}'::jsonb,
 '{"attempted":"activity.started","interacted":"activity.input_changed","completed":"activity.completed"}'::jsonb,
 'H5pXapiEvaluator');

-- --------------------------------------------------------------------------
-- Native React 元件
-- --------------------------------------------------------------------------
INSERT INTO interactive_definitions
  (component_type, schema_version, display_name,
   config_schema, runtime_schema, result_schema, answer_key_schema,
   event_mapping, server_evaluator) VALUES

('native.ParameterControl', '1.0', '參數操作',
 '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["parameters"],"additionalProperties":false,"properties":{"parameters":{"type":"array","minItems":1,"maxItems":10,"items":{"type":"object","required":["id","label","min","max","step"],"additionalProperties":false,"properties":{"id":{"type":"string"},"label":{"type":"string"},"unit":{"type":"string"},"min":{"type":"number"},"max":{"type":"number"},"step":{"type":"number"}}}},"instructions":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"parameters":{"type":"array"},"currentValues":{"type":"object"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"additionalProperties":false,"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array","items":{"type":"object","required":["code","category","severity"],"properties":{"code":{"type":"string"},"category":{"type":"string"},"severity":{"enum":["low","medium","high"]},"parameter_id":{"type":"string"}}}},"feedback_data":{"type":"object"}}}'::jsonb,
 '{"type":"object","properties":{"acceptable_ranges":{"type":"array","items":{"type":"object","required":["parameter_id","min","max"],"properties":{"parameter_id":{"type":"string"},"min":{"type":"number"},"max":{"type":"number"},"issue_code_if_high":{"type":"string"},"issue_code_if_low":{"type":"string"}}}},"scoring":{"type":"object","properties":{"per_parameter_points":{"type":"number"},"pass_threshold":{"type":"number"}}}}}'::jsonb,
 '{"change":"activity.input_changed","submit":"activity.submitted"}'::jsonb,
 'ParameterRangeEvaluator'),

('native.StepSequence', '1.0', '步驟排序',
 '{"type":"object","required":["steps"],"properties":{"steps":{"type":"array","items":{"type":"object","required":["id","label"]}},"instructions":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"steps":{"type":"array"},"currentOrder":{"type":"array"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"correct_order":{"type":"array"},"partial_credit":{"type":"boolean"}}}'::jsonb,
 '{"change":"activity.input_changed","submit":"activity.submitted"}'::jsonb,
 'SequenceOrderEvaluator'),

('native.Timeline', '1.0', '時間軸排序',
 '{"type":"object","required":["events"],"properties":{"events":{"type":"array"},"instructions":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"events":{"type":"array"},"placements":{"type":"object"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"correct_order":{"type":"array"},"tolerance":{"type":"number"}}}'::jsonb,
 '{"change":"activity.input_changed","submit":"activity.submitted"}'::jsonb,
 'SequenceOrderEvaluator'),

('native.ScenarioChoice', '1.0', '情境選擇',
 '{"type":"object","required":["nodes"],"properties":{"nodes":{"type":"array"},"startNodeId":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"nodes":{"type":"array"},"path":{"type":"array"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"acceptable_paths":{"type":"array"},"penalty_nodes":{"type":"array"}}}'::jsonb,
 '{"choose":"activity.input_changed","submit":"activity.submitted"}'::jsonb,
 'ChoicePathEvaluator'),

('native.FormSimulation', '1.0', '表單模擬',
 '{"type":"object","required":["fields"],"properties":{"fields":{"type":"array"},"instructions":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"fields":{"type":"array"},"values":{"type":"object"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"field_rules":{"type":"array"},"pass_threshold":{"type":"number"}}}'::jsonb,
 '{"change":"activity.input_changed","submit":"activity.submitted"}'::jsonb,
 'FormRuleEvaluator'),

('native.ProcessBuilder', '1.0', '流程建構',
 '{"type":"object","required":["palette"],"properties":{"palette":{"type":"array"},"instructions":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"palette":{"type":"array"},"graph":{"type":"object"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"expected_graph":{"type":"object"},"match_mode":{"enum":["exact","isomorphic","partial"]}}}'::jsonb,
 '{"change":"activity.input_changed","submit":"activity.submitted"}'::jsonb,
 'GraphMatchEvaluator'),

('native.FlowBuilder', '1.0', '節點流程圖（React Flow）',
 '{"type":"object","required":["nodeTypes"],"properties":{"nodeTypes":{"type":"array"},"instructions":{"type":"string"}}}'::jsonb,
 '{"type":"object","properties":{"nodeTypes":{"type":"array"},"nodes":{"type":"array"},"edges":{"type":"array"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"expected_graph":{"type":"object"},"match_mode":{"enum":["exact","isomorphic","partial"]}}}'::jsonb,
 '{"change":"activity.input_changed","submit":"activity.submitted"}'::jsonb,
 'GraphMatchEvaluator'),

('native.DataInterpretation', '1.0', '資料判讀',
 '{"type":"object","required":["dataset"],"properties":{"dataset":{"type":"object"},"questions":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"dataset":{"type":"object"},"answers":{"type":"object"}}}'::jsonb,
 '{"type":"object","required":["status","score","max_score","issues"],"properties":{"status":{"enum":["passed","completed","needs_improvement","failed"]},"score":{"type":["number","null"]},"max_score":{"type":"number"},"issues":{"type":"array"}}}'::jsonb,
 '{"type":"object","properties":{"rubric":{"type":"array"},"pass_threshold":{"type":"number"}}}'::jsonb,
 '{"change":"activity.input_changed","submit":"activity.submitted"}'::jsonb,
 'RubricEvaluator');

INSERT INTO schema_migrations (version) VALUES ('0013_seed_interactive_definitions')
  ON CONFLICT DO NOTHING;

COMMIT;
