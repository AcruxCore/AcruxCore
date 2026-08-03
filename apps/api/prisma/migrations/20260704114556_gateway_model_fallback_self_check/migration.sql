-- A model cannot be its own fallback.
ALTER TABLE "gateway_model_fallbacks"
  ADD CONSTRAINT "gateway_model_fallbacks_no_self"
  CHECK ("model_id" <> "fallback_model_id");
