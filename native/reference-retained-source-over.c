#include <math.h>
#include <node_api.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, "CUT_NATIVE_SOURCE_OVER", message);
  return NULL;
}

static bool uint8_view(
  napi_env env,
  napi_value value,
  uint8_t **data,
  size_t *length
) {
  napi_typedarray_type type;
  size_t byte_offset;
  napi_value array_buffer;
  void *raw = NULL;
  if (napi_get_typedarray_info(
        env,
        value,
        &type,
        length,
        &raw,
        &array_buffer,
        &byte_offset
      ) != napi_ok || type != napi_uint8_array || raw == NULL) {
    return false;
  }
  *data = (uint8_t *)raw;
  return true;
}

static bool float64_view(
  napi_env env,
  napi_value value,
  double **data,
  size_t *length
) {
  napi_typedarray_type type;
  size_t byte_offset;
  napi_value array_buffer;
  void *raw = NULL;
  if (napi_get_typedarray_info(
        env,
        value,
        &type,
        length,
        &raw,
        &array_buffer,
        &byte_offset
      ) != napi_ok || type != napi_float64_array || raw == NULL) {
    return false;
  }
  *data = (double *)raw;
  return true;
}

static bool float32_view(
  napi_env env,
  napi_value value,
  float **data,
  size_t *length
) {
  napi_typedarray_type type;
  size_t byte_offset;
  napi_value array_buffer;
  void *raw = NULL;
  if (napi_get_typedarray_info(
        env,
        value,
        &type,
        length,
        &raw,
        &array_buffer,
        &byte_offset
      ) != napi_ok || type != napi_float32_array || raw == NULL) {
    return false;
  }
  *data = (float *)raw;
  return true;
}

static bool uint32_arg(napi_env env, napi_value value, uint32_t *result) {
  return napi_get_value_uint32(env, value, result) == napi_ok;
}

static bool double_arg(napi_env env, napi_value value, double *result) {
  return napi_get_value_double(env, value, result) == napi_ok
    && isfinite(*result);
}

static bool safe_int64_arg(napi_env env, napi_value value, int64_t *result) {
  double observed = 0.0;
  if (!double_arg(env, value, &observed)
      || trunc(observed) != observed
      || observed < -9007199254740991.0
      || observed > 9007199254740991.0) {
    return false;
  }
  *result = (int64_t)observed;
  return true;
}

/* JavaScript Math.round chooses the integer toward +infinity at an exact
 * half. The retained-media sampler depends on that law for negative source
 * coordinates, so C's round()/llround() are not equivalent. */
static bool js_round_safe_integer(double value, int64_t *result) {
  const double rounded = floor(value + 0.5);
  if (!isfinite(rounded)
      || rounded < -9007199254740991.0
      || rounded > 9007199254740991.0) {
    return false;
  }
  *result = (int64_t)rounded;
  return true;
}

static int64_t floor_div_q16(int64_t value) {
  const int64_t units = 65536;
  int64_t quotient = value / units;
  const int64_t remainder = value % units;
  if (remainder < 0) quotient -= 1;
  return quotient;
}

static uint8_t rounded_clamped_255(double value) {
  const double clamped = value <= 0.0 ? 0.0 : value >= 255.0 ? 255.0 : value;
  return (uint8_t)floor(clamped + 0.5);
}

static uint8_t rounded_ratio_u64(uint64_t numerator, uint64_t denominator) {
  return (uint8_t)((numerator * 2U + denominator) / (denominator * 2U));
}

static bool set_bigint_property(
  napi_env env,
  napi_value object,
  const char *name,
  uint64_t value
) {
  napi_value encoded;
  return napi_create_bigint_uint64(env, value, &encoded) == napi_ok
    && napi_set_named_property(env, object, name, encoded) == napi_ok;
}

static bool set_boolean_property(
  napi_env env,
  napi_value object,
  const char *name,
  bool value
) {
  napi_value encoded;
  return napi_get_boolean(env, value, &encoded) == napi_ok
    && napi_set_named_property(env, object, name, encoded) == napi_ok;
}

static uint8_t rounded_byte(double value) {
  const double clamped = value <= 0.0 ? 0.0 : value >= 1.0 ? 1.0 : value;
  return (uint8_t)floor(clamped * 255.0 + 0.5);
}

static uint8_t exact_linear_to_srgb_byte(
  double value,
  const double *thresholds,
  const uint8_t *bucket_base,
  uint64_t *fallbacks
) {
  const double linear = value <= 0.0 ? 0.0 : value >= 1.0 ? 1.0 : value;
  uint32_t bucket = (uint32_t)floor(linear * 65535.0);
  if (bucket > 65535U) bucket = 65535U;
  uint8_t output = bucket_base[bucket];
  while (output < 255U && linear >= thresholds[output]) output += 1U;
  while (output > 0U && linear < thresholds[output - 1U]) output -= 1U;
  const bool near_lower = output > 0U && fabs(linear - thresholds[output - 1U]) <= 1e-12;
  const bool near_upper = output < 255U && fabs(linear - thresholds[output]) <= 1e-12;
  if (near_lower || near_upper) {
    *fallbacks += 1U;
    const double encoded = linear <= 0.0031308
      ? linear * 12.92
      : 1.055 * pow(linear, 1.0 / 2.4) - 0.055;
    return rounded_byte(encoded);
  }
  return output;
}

static napi_value composite(napi_env env, napi_callback_info info) {
  size_t argc = 14;
  napi_value argv[14];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 14) {
    return fail(env, "expected exactly fourteen closed kernel arguments");
  }

  uint8_t *backdrop = NULL;
  uint8_t *source = NULL;
  uint8_t *bucket_base = NULL;
  double *srgb_to_linear = NULL;
  double *thresholds = NULL;
  double *source_outside = NULL;
  double *source_inside = NULL;
  double *backdrop_outside = NULL;
  double *output_alpha = NULL;
  uint8_t *output_alpha_byte = NULL;
  size_t backdrop_length = 0;
  size_t source_length = 0;
  size_t srgb_length = 0;
  size_t threshold_length = 0;
  size_t bucket_length = 0;
  size_t source_outside_length = 0;
  size_t source_inside_length = 0;
  size_t backdrop_outside_length = 0;
  size_t output_alpha_length = 0;
  size_t output_alpha_byte_length = 0;
  uint32_t width = 0;
  uint32_t left = 0;
  uint32_t top = 0;
  uint32_t right = 0;
  uint32_t bottom = 0;

  if (!uint8_view(env, argv[0], &backdrop, &backdrop_length)
      || !uint8_view(env, argv[1], &source, &source_length)
      || !uint32_arg(env, argv[2], &width)
      || !uint32_arg(env, argv[3], &left)
      || !uint32_arg(env, argv[4], &top)
      || !uint32_arg(env, argv[5], &right)
      || !uint32_arg(env, argv[6], &bottom)
      || !float64_view(env, argv[7], &srgb_to_linear, &srgb_length)
      || !float64_view(env, argv[8], &thresholds, &threshold_length)
      || !uint8_view(env, argv[9], &bucket_base, &bucket_length)
      || !float64_view(env, argv[10], &source_outside, &source_outside_length)
      || !float64_view(env, argv[11], &source_inside, &source_inside_length)
      || !float64_view(env, argv[12], &backdrop_outside, &backdrop_outside_length)
      || !float64_view(env, argv[13], &output_alpha, &output_alpha_length)) {
    return fail(env, "kernel arguments have invalid typed-array or integer shapes");
  }

  /* output-alpha bytes are derived from the exact alpha term. Avoid another
   * large argument while retaining the JS law's Math.round equivalent. */
  output_alpha_byte = NULL;
  output_alpha_byte_length = 0;
  (void)output_alpha_byte;
  (void)output_alpha_byte_length;

  if (width == 0U || left > right || top > bottom || right > width
      || backdrop_length != source_length || backdrop_length % 4U != 0U
      || backdrop_length / 4U % width != 0U
      || bottom > backdrop_length / 4U / width
      || srgb_length != 256U || threshold_length != 255U
      || bucket_length != 65536U
      || source_outside_length != 65536U || source_inside_length != 65536U
      || backdrop_outside_length != 65536U || output_alpha_length != 65536U) {
    return fail(env, "kernel dimensions, bounds, or lookup tables are inconsistent");
  }
  if ((backdrop <= source && source < backdrop + backdrop_length)
      || (source <= backdrop && backdrop < source + source_length)) {
    return fail(env, "source bytes must not alias the destination accumulator");
  }

  uint64_t fast_pixels = 0U;
  uint64_t fallback_channels = 0U;
  uint64_t newly_covered = 0U;
  for (uint32_t y = top; y < bottom; y += 1U) {
    const size_t row_end = ((size_t)y * width + right) * 4U;
    for (size_t offset = ((size_t)y * width + left) * 4U;
         offset < row_end;
         offset += 4U) {
      const uint8_t backdrop_alpha_byte = backdrop[offset + 3U];
      const uint8_t source_alpha_byte = source[offset + 3U];
      if (source_alpha_byte == 0U) {
        if (backdrop_alpha_byte == 0U) {
          backdrop[offset] = 0U;
          backdrop[offset + 1U] = 0U;
          backdrop[offset + 2U] = 0U;
          backdrop[offset + 3U] = 0U;
        }
        continue;
      }
      if (backdrop_alpha_byte == 0U) newly_covered += 1U;
      if (source_alpha_byte == 255U || backdrop_alpha_byte == 0U) {
        backdrop[offset] = source[offset];
        backdrop[offset + 1U] = source[offset + 1U];
        backdrop[offset + 2U] = source[offset + 2U];
        backdrop[offset + 3U] = source_alpha_byte;
        continue;
      }
      const uint32_t alpha_index = (uint32_t)backdrop_alpha_byte * 256U + source_alpha_byte;
      const double alpha = output_alpha[alpha_index];
      for (uint32_t channel = 0U; channel < 3U; channel += 1U) {
        const double backdrop_channel = srgb_to_linear[backdrop[offset + channel]];
        const double source_channel = srgb_to_linear[source[offset + channel]];
        const double premultiplied = source_outside[alpha_index] * source_channel
          + source_inside[alpha_index] * source_channel
          + backdrop_outside[alpha_index] * backdrop_channel;
        backdrop[offset + channel] = exact_linear_to_srgb_byte(
          alpha > 0.0 ? premultiplied / alpha : 0.0,
          thresholds,
          bucket_base,
          &fallback_channels
        );
      }
      backdrop[offset + 3U] = rounded_byte(alpha);
      fast_pixels += 1U;
    }
  }

  napi_value result;
  napi_value value;
  if (napi_create_object(env, &result) != napi_ok
      || napi_create_bigint_uint64(env, fast_pixels, &value) != napi_ok
      || napi_set_named_property(env, result, "fastPixels", value) != napi_ok
      || napi_create_bigint_uint64(env, fallback_channels, &value) != napi_ok
      || napi_set_named_property(env, result, "fallbackChannels", value) != napi_ok
      || napi_create_bigint_uint64(env, newly_covered, &value) != napi_ok
      || napi_set_named_property(env, result, "newlyCoveredPixels", value) != napi_ok) {
    return fail(env, "could not publish native kernel counters");
  }
  return result;
}

/* Exact native form of CUT's retained-media Q16 associated-alpha bilinear
 * raster. This kernel deliberately materializes the same straight-RGBA
 * viewport as the scalar reference path; composition remains a separate
 * semantic operation. The candidate removes JavaScript per-tap work without
 * changing source-over order, opacity rounding, hidden-RGB clearing, or the
 * retained execution receipt. */
static napi_value raster_retained_media_viewport(
  napi_env env,
  napi_callback_info info
) {
  size_t argc = 17;
  napi_value argv[17];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok
      || argc != 17) {
    return fail(env, "expected exactly seventeen retained-raster arguments");
  }

  uint8_t *source = NULL;
  uint8_t *output = NULL;
  size_t source_length = 0;
  size_t output_length = 0;
  uint32_t source_width = 0;
  uint32_t source_height = 0;
  uint32_t output_width = 0;
  uint32_t output_height = 0;
  uint32_t left = 0;
  uint32_t top = 0;
  uint32_t right = 0;
  uint32_t bottom = 0;
  double affine_tx = 0.0;
  double affine_ty = 0.0;
  double inverse_a = 0.0;
  double inverse_b = 0.0;
  double inverse_c = 0.0;
  double inverse_d = 0.0;
  double opacity = 0.0;

  if (!uint8_view(env, argv[0], &source, &source_length)
      || !uint8_view(env, argv[1], &output, &output_length)
      || !uint32_arg(env, argv[2], &source_width)
      || !uint32_arg(env, argv[3], &source_height)
      || !uint32_arg(env, argv[4], &output_width)
      || !uint32_arg(env, argv[5], &output_height)
      || !uint32_arg(env, argv[6], &left)
      || !uint32_arg(env, argv[7], &top)
      || !uint32_arg(env, argv[8], &right)
      || !uint32_arg(env, argv[9], &bottom)
      || !double_arg(env, argv[10], &affine_tx)
      || !double_arg(env, argv[11], &affine_ty)
      || !double_arg(env, argv[12], &inverse_a)
      || !double_arg(env, argv[13], &inverse_b)
      || !double_arg(env, argv[14], &inverse_c)
      || !double_arg(env, argv[15], &inverse_d)
      || !double_arg(env, argv[16], &opacity)) {
    return fail(env, "retained-raster arguments have invalid closed shapes");
  }

  if (source_width == 0U || source_height == 0U
      || output_width == 0U || output_height == 0U
      || source_length != (size_t)source_width * source_height * 4U
      || output_length != (size_t)output_width * output_height * 4U
      || left > right || top > bottom
      || right > output_width || bottom > output_height
      || opacity < 0.0 || opacity > 1.0
      || (source <= output && output < source + source_length)
      || (output <= source && source < output + output_length)) {
    return fail(env, "retained-raster dimensions, bounds, opacity, or ownership are invalid");
  }

  memset(output, 0, output_length);
  const double q16 = 65536.0;
  const double q32 = 4294967296.0;
  uint64_t alpha_tap_reads = 0U;
  uint64_t tap_evaluations = 0U;
  uint64_t zero_weight_taps = 0U;
  uint64_t output_pixels_written = 0U;
  uint32_t support_left = output_width;
  uint32_t support_top = output_height;
  uint32_t support_right = 0U;
  uint32_t support_bottom = 0U;

  for (uint32_t y = top; y < bottom; y += 1U) {
    const double dy = (double)y - affine_ty;
    for (uint32_t x = left; x < right; x += 1U) {
      const double dx = (double)x - affine_tx;
      int64_t sx_q = 0;
      int64_t sy_q = 0;
      /* Parentheses preserve the JavaScript multiply/add order. The build
       * intentionally omits fast-math so these terms are not reassociated. */
      if (!js_round_safe_integer(((inverse_a * dx) + (inverse_c * dy)) * q16, &sx_q)
          || !js_round_safe_integer(((inverse_b * dx) + (inverse_d * dy)) * q16, &sy_q)) {
        return fail(env, "retained-raster source coordinates exceed the exact safe-integer domain");
      }
      const int64_t x0 = floor_div_q16(sx_q);
      const int64_t y0 = floor_div_q16(sy_q);
      const uint64_t fx = (uint64_t)(sx_q - x0 * 65536);
      const uint64_t fy = (uint64_t)(sy_q - y0 * 65536);
      const uint64_t weights[4] = {
        (65536U - fx) * (65536U - fy),
        fx * (65536U - fy),
        (65536U - fx) * fy,
        fx * fy,
      };
      const int64_t sample_x[4] = { x0, x0 + 1, x0, x0 + 1 };
      const int64_t sample_y[4] = { y0, y0, y0 + 1, y0 + 1 };
      double alpha = 0.0;
      double red = 0.0;
      double green = 0.0;
      double blue = 0.0;
      for (uint32_t tap = 0U; tap < 4U; tap += 1U) {
        tap_evaluations += 1U;
        if (weights[tap] == 0U) {
          zero_weight_taps += 1U;
          continue;
        }
        if (sample_x[tap] < 0 || sample_y[tap] < 0
            || sample_x[tap] >= (int64_t)source_width
            || sample_y[tap] >= (int64_t)source_height) {
          continue;
        }
        const size_t offset = (
          (size_t)sample_y[tap] * source_width + (size_t)sample_x[tap]
        ) * 4U;
        const double weight = (double)weights[tap] / q32;
        const double source_alpha = (double)source[offset + 3U];
        alpha_tap_reads += 1U;
        alpha += source_alpha * weight;
        red += ((double)source[offset] * source_alpha) * weight;
        green += ((double)source[offset + 1U] * source_alpha) * weight;
        blue += ((double)source[offset + 2U] * source_alpha) * weight;
      }
      const uint8_t scaled_alpha = rounded_clamped_255(alpha * opacity);
      if (scaled_alpha == 0U || alpha <= 0.0) continue;
      const size_t destination = ((size_t)y * output_width + x) * 4U;
      output[destination] = rounded_clamped_255(red / alpha);
      output[destination + 1U] = rounded_clamped_255(green / alpha);
      output[destination + 2U] = rounded_clamped_255(blue / alpha);
      output[destination + 3U] = scaled_alpha;
      output_pixels_written += 1U;
      if (x < support_left) support_left = x;
      if (y < support_top) support_top = y;
      if (x + 1U > support_right) support_right = x + 1U;
      if (y + 1U > support_bottom) support_bottom = y + 1U;
    }
  }

  if (output_pixels_written == 0U) {
    support_left = 0U;
    support_top = 0U;
    support_right = 0U;
    support_bottom = 0U;
  }
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok
      || !set_bigint_property(env, result, "alphaTapReads", alpha_tap_reads)
      || !set_bigint_property(env, result, "tapEvaluations", tap_evaluations)
      || !set_bigint_property(env, result, "zeroWeightTaps", zero_weight_taps)
      || !set_bigint_property(env, result, "outputPixelsWritten", output_pixels_written)
      || !set_bigint_property(env, result, "nonzeroAlphaPixels", output_pixels_written)
      || !set_bigint_property(env, result, "left", support_left)
      || !set_bigint_property(env, result, "top", support_top)
      || !set_bigint_property(env, result, "right", support_right)
      || !set_bigint_property(env, result, "bottom", support_bottom)) {
    return fail(env, "could not publish retained-raster counters");
  }
  return result;
}

/* Execute CUT's already-planned exact Q16 scale+translation coordinates.
 * The JavaScript planner remains authoritative for rational geometry; this
 * kernel only replaces the destination-pixel/tap loop and publishes the same
 * semantic work counters. */
static napi_value raster_local_space_scale_translation_q16(
  napi_env env,
  napi_callback_info info
) {
  size_t argc = 8;
  napi_value argv[8];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok
      || argc != 8) {
    return fail(env, "expected exactly eight local-space Q16 raster arguments");
  }

  uint8_t *source = NULL;
  uint8_t *output = NULL;
  double *source_x_q16 = NULL;
  double *source_y_q16 = NULL;
  size_t source_length = 0;
  size_t output_length = 0;
  size_t source_x_length = 0;
  size_t source_y_length = 0;
  uint32_t source_width = 0;
  uint32_t source_height = 0;

  if (!uint8_view(env, argv[0], &source, &source_length)
      || !uint8_view(env, argv[1], &output, &output_length)
      || !uint32_arg(env, argv[2], &source_width)
      || !uint32_arg(env, argv[3], &source_height)
      || !float64_view(env, argv[4], &source_x_q16, &source_x_length)
      || !float64_view(env, argv[5], &source_y_q16, &source_y_length)) {
    return fail(env, "local-space Q16 raster arguments have invalid closed shapes");
  }

  uint32_t output_width = 0;
  uint32_t output_height = 0;
  if (!uint32_arg(env, argv[6], &output_width)
      || !uint32_arg(env, argv[7], &output_height)
      || source_width == 0U || source_height == 0U
      || output_width == 0U || output_height == 0U
      || source_x_length != output_width || source_y_length != output_height
      || source_length != (size_t)source_width * source_height * 4U
      || output_length != (size_t)output_width * output_height * 4U) {
    return fail(env, "local-space Q16 raster dimensions or coordinate lengths are inconsistent");
  }
  const uintptr_t source_start = (uintptr_t)source;
  const uintptr_t source_end = source_start + source_length;
  const uintptr_t output_start = (uintptr_t)output;
  const uintptr_t output_end = output_start + output_length;
  if (source_end < source_start || output_end < output_start
      || (source_start < output_end && output_start < source_end)) {
    return fail(env, "local-space Q16 source bytes must not alias output bytes");
  }

  memset(output, 0, output_length);
  const int64_t units = 65536;
  const uint64_t denominator = 4294967296U;
  uint64_t integer_samples_copied = 0U;
  uint64_t bilinear_samples_evaluated = 0U;
  uint64_t source_taps_read = 0U;

  for (uint32_t output_y = 0U; output_y < output_height; output_y += 1U) {
    const double y_value = source_y_q16[output_y];
    if (!isfinite(y_value) || trunc(y_value) != y_value
        || y_value < -9007199254740991.0 || y_value > 9007199254740991.0) {
      return fail(env, "local-space Q16 Y coordinate is not one exact safe integer");
    }
    const int64_t y_q16 = (int64_t)y_value;
    for (uint32_t output_x = 0U; output_x < output_width; output_x += 1U) {
      const double x_value = source_x_q16[output_x];
      if (!isfinite(x_value) || trunc(x_value) != x_value
          || x_value < -9007199254740991.0 || x_value > 9007199254740991.0) {
        return fail(env, "local-space Q16 X coordinate is not one exact safe integer");
      }
      const int64_t x_q16 = (int64_t)x_value;
      const size_t output_offset = ((size_t)output_y * output_width + output_x) * 4U;
      if (x_q16 % units == 0 && y_q16 % units == 0) {
        const int64_t source_x = x_q16 / units;
        const int64_t source_y = y_q16 / units;
        if (source_x >= 0 && source_y >= 0
            && source_x < (int64_t)source_width && source_y < (int64_t)source_height) {
          const size_t source_offset = ((size_t)source_y * source_width + (size_t)source_x) * 4U;
          memcpy(output + output_offset, source + source_offset, 4U);
          integer_samples_copied += 1U;
          source_taps_read += 1U;
        }
        continue;
      }

      bilinear_samples_evaluated += 1U;
      const int64_t x0 = floor_div_q16(x_q16);
      const int64_t y0 = floor_div_q16(y_q16);
      const uint64_t fraction_x = (uint64_t)(x_q16 - x0 * units);
      const uint64_t fraction_y = (uint64_t)(y_q16 - y0 * units);
      const uint64_t inverse_x = (uint64_t)units - fraction_x;
      const uint64_t inverse_y = (uint64_t)units - fraction_y;
      const uint64_t weights[4] = {
        inverse_x * inverse_y,
        fraction_x * inverse_y,
        inverse_x * fraction_y,
        fraction_x * fraction_y,
      };
      const int64_t sample_x[4] = { x0, x0 + 1, x0, x0 + 1 };
      const int64_t sample_y[4] = { y0, y0, y0 + 1, y0 + 1 };
      uint64_t alpha_numerator = 0U;
      uint64_t red_numerator = 0U;
      uint64_t green_numerator = 0U;
      uint64_t blue_numerator = 0U;
      for (uint32_t tap = 0U; tap < 4U; tap += 1U) {
        if (weights[tap] == 0U
            || sample_x[tap] < 0 || sample_y[tap] < 0
            || sample_x[tap] >= (int64_t)source_width
            || sample_y[tap] >= (int64_t)source_height) {
          continue;
        }
        source_taps_read += 1U;
        const size_t source_offset = ((size_t)sample_y[tap] * source_width + (size_t)sample_x[tap]) * 4U;
        const uint64_t alpha = source[source_offset + 3U];
        if (alpha == 0U) continue;
        const uint64_t weighted_alpha = alpha * weights[tap];
        alpha_numerator += weighted_alpha;
        red_numerator += (uint64_t)source[source_offset] * weighted_alpha;
        green_numerator += (uint64_t)source[source_offset + 1U] * weighted_alpha;
        blue_numerator += (uint64_t)source[source_offset + 2U] * weighted_alpha;
      }
      const uint8_t alpha = rounded_ratio_u64(alpha_numerator, denominator);
      if (alpha == 0U || alpha_numerator == 0U) continue;
      output[output_offset] = rounded_ratio_u64(red_numerator, alpha_numerator);
      output[output_offset + 1U] = rounded_ratio_u64(green_numerator, alpha_numerator);
      output[output_offset + 2U] = rounded_ratio_u64(blue_numerator, alpha_numerator);
      output[output_offset + 3U] = alpha;
    }
  }

  napi_value result;
  if (napi_create_object(env, &result) != napi_ok
      || !set_bigint_property(env, result, "integerSamplesCopied", integer_samples_copied)
      || !set_bigint_property(env, result, "bilinearSamplesEvaluated", bilinear_samples_evaluated)
      || !set_bigint_property(env, result, "sourceTapsRead", source_taps_read)) {
    return fail(env, "could not publish local-space Q16 raster counters");
  }
  return result;
}

/* Exact native form of CUT's bounded fractional retained translation. The
 * parent owns Q16 quantization and alpha-bound authority; this kernel clears
 * and fills one full destination surface while returning the frozen support
 * and work counters. */
static napi_value translate_retained_surface_q16(
  napi_env env,
  napi_callback_info info
) {
  size_t argc = 14;
  napi_value argv[14];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok
      || argc != 14) {
    return fail(env, "expected exactly fourteen retained-translation arguments");
  }
  uint8_t *source = NULL;
  uint8_t *output = NULL;
  size_t source_length = 0;
  size_t output_length = 0;
  uint32_t source_width = 0;
  uint32_t source_height = 0;
  uint32_t canvas_width = 0;
  uint32_t canvas_height = 0;
  int64_t integer_x = 0;
  int64_t integer_y = 0;
  uint32_t phase_x = 0;
  uint32_t phase_y = 0;
  uint32_t bound_left = 0;
  uint32_t bound_top = 0;
  uint32_t bound_right = 0;
  uint32_t bound_bottom = 0;
  if (!uint8_view(env, argv[0], &source, &source_length)
      || !uint8_view(env, argv[1], &output, &output_length)
      || !uint32_arg(env, argv[2], &source_width)
      || !uint32_arg(env, argv[3], &source_height)
      || !uint32_arg(env, argv[4], &canvas_width)
      || !uint32_arg(env, argv[5], &canvas_height)
      || !safe_int64_arg(env, argv[6], &integer_x)
      || !safe_int64_arg(env, argv[7], &integer_y)
      || !uint32_arg(env, argv[8], &phase_x)
      || !uint32_arg(env, argv[9], &phase_y)
      || !uint32_arg(env, argv[10], &bound_left)
      || !uint32_arg(env, argv[11], &bound_top)
      || !uint32_arg(env, argv[12], &bound_right)
      || !uint32_arg(env, argv[13], &bound_bottom)) {
    return fail(env, "retained-translation arguments have invalid closed shapes");
  }
  const uintptr_t source_start = (uintptr_t)source;
  const uintptr_t source_end = source_start + source_length;
  const uintptr_t output_start = (uintptr_t)output;
  const uintptr_t output_end = output_start + output_length;
  if (source_width == 0U || source_height == 0U
      || canvas_width == 0U || canvas_height == 0U
      || source_length != (size_t)source_width * source_height * 4U
      || output_length != (size_t)canvas_width * canvas_height * 4U
      || (phase_x == 0U && phase_y == 0U)
      || phase_x >= 65536U || phase_y >= 65536U
      || bound_left > bound_right || bound_top > bound_bottom
      || bound_right > source_width || bound_bottom > source_height
      || source_end < source_start || output_end < output_start
      || (source_start < output_end && output_start < source_end)) {
    return fail(env, "retained-translation dimensions, phase, bounds, or ownership are invalid");
  }
  memset(output, 0, output_length);
  uint32_t support_left = canvas_width;
  uint32_t support_top = canvas_height;
  uint32_t support_right = 0U;
  uint32_t support_bottom = 0U;
  uint64_t nonzero = 0U;
  uint64_t alpha_bytes_observed = 0U;
  uint64_t destination_pixels_visited = 0U;
  if (bound_left < bound_right && bound_top < bound_bottom) {
    const int64_t first_x = integer_x + (int64_t)bound_left < 0
      ? 0 : integer_x + (int64_t)bound_left;
    const int64_t first_y = integer_y + (int64_t)bound_top < 0
      ? 0 : integer_y + (int64_t)bound_top;
    const int64_t last_x_unclipped = integer_x + (int64_t)bound_right - 1
      + (phase_x == 0U ? 0 : 1);
    const int64_t last_y_unclipped = integer_y + (int64_t)bound_bottom - 1
      + (phase_y == 0U ? 0 : 1);
    const int64_t last_x = last_x_unclipped >= (int64_t)canvas_width
      ? (int64_t)canvas_width - 1 : last_x_unclipped;
    const int64_t last_y = last_y_unclipped >= (int64_t)canvas_height
      ? (int64_t)canvas_height - 1 : last_y_unclipped;
    if (first_x <= last_x && first_y <= last_y) {
      const uint64_t inverse_x = 65536U - phase_x;
      const uint64_t inverse_y = 65536U - phase_y;
      const uint64_t denominator = 4294967296U;
      destination_pixels_visited = (uint64_t)(last_x - first_x + 1) * (uint64_t)(last_y - first_y + 1);
      for (int64_t destination_y = first_y; destination_y <= last_y; destination_y += 1) {
        const int64_t local_y = destination_y - integer_y;
        const int64_t source_y[2] = { local_y - 1, local_y };
        const uint64_t weight_y[2] = { phase_y, inverse_y };
        for (int64_t destination_x = first_x; destination_x <= last_x; destination_x += 1) {
          const int64_t local_x = destination_x - integer_x;
          const int64_t source_x[2] = { local_x - 1, local_x };
          const uint64_t weight_x[2] = { phase_x, inverse_x };
          uint64_t alpha_numerator = 0U;
          uint64_t red_numerator = 0U;
          uint64_t green_numerator = 0U;
          uint64_t blue_numerator = 0U;
          for (uint32_t y_index = 0U; y_index < 2U; y_index += 1U) {
            if (weight_y[y_index] == 0U
                || source_y[y_index] < (int64_t)bound_top
                || source_y[y_index] >= (int64_t)bound_bottom) continue;
            for (uint32_t x_index = 0U; x_index < 2U; x_index += 1U) {
              if (weight_x[x_index] == 0U
                  || source_x[x_index] < (int64_t)bound_left
                  || source_x[x_index] >= (int64_t)bound_right) continue;
              alpha_bytes_observed += 1U;
              const uint64_t weight = weight_x[x_index] * weight_y[y_index];
              const size_t source_offset = ((size_t)source_y[y_index] * source_width + (size_t)source_x[x_index]) * 4U;
              const uint64_t alpha = source[source_offset + 3U];
              if (alpha == 0U) continue;
              const uint64_t weighted_alpha = alpha * weight;
              alpha_numerator += weighted_alpha;
              red_numerator += (uint64_t)source[source_offset] * weighted_alpha;
              green_numerator += (uint64_t)source[source_offset + 1U] * weighted_alpha;
              blue_numerator += (uint64_t)source[source_offset + 2U] * weighted_alpha;
            }
          }
          const uint8_t alpha = rounded_ratio_u64(alpha_numerator, denominator);
          if (alpha == 0U || alpha_numerator == 0U) continue;
          const size_t destination_offset = ((size_t)destination_y * canvas_width + (size_t)destination_x) * 4U;
          output[destination_offset] = rounded_ratio_u64(red_numerator, alpha_numerator);
          output[destination_offset + 1U] = rounded_ratio_u64(green_numerator, alpha_numerator);
          output[destination_offset + 2U] = rounded_ratio_u64(blue_numerator, alpha_numerator);
          output[destination_offset + 3U] = alpha;
          nonzero += 1U;
          if ((uint32_t)destination_x < support_left) support_left = (uint32_t)destination_x;
          if ((uint32_t)destination_y < support_top) support_top = (uint32_t)destination_y;
          if ((uint32_t)destination_x + 1U > support_right) support_right = (uint32_t)destination_x + 1U;
          if ((uint32_t)destination_y + 1U > support_bottom) support_bottom = (uint32_t)destination_y + 1U;
        }
      }
    }
  }
  const bool empty = nonzero == 0U;
  if (empty) support_left = support_top = support_right = support_bottom = 0U;
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok
      || !set_boolean_property(env, result, "empty", empty)
      || !set_bigint_property(env, result, "left", support_left)
      || !set_bigint_property(env, result, "top", support_top)
      || !set_bigint_property(env, result, "right", support_right)
      || !set_bigint_property(env, result, "bottom", support_bottom)
      || !set_bigint_property(env, result, "nonzeroAlphaPixels", nonzero)
      || !set_bigint_property(env, result, "alphaBytesObserved", alpha_bytes_observed)
      || !set_bigint_property(env, result, "destinationPixelsVisited", destination_pixels_visited)) {
    return fail(env, "could not publish retained-translation counters");
  }
  return result;
}

/* Exact native form of the long-form limiter's phase-specialized BS.1770
 * envelope kernel. Inputs and coefficients remain caller-owned typed arrays;
 * this function writes only the separately-owned output envelope. The build
 * disables FP contraction so every multiply and add retains the JavaScript
 * scalar law's separate IEEE-754 rounding boundary. */
static napi_value derive_limiter_envelope_range(
  napi_env env,
  napi_callback_info info
) {
  size_t argc = 11;
  napi_value argv[11];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok
      || argc != 11) {
    return fail(env, "expected exactly eleven limiter-envelope arguments");
  }

  float *decoded = NULL;
  double *output = NULL;
  double *coefficients = NULL;
  size_t decoded_length = 0;
  size_t output_length = 0;
  size_t coefficient_length = 0;
  uint32_t total_frames = 0;
  uint32_t range_start = 0;
  uint32_t range_end = 0;
  uint32_t read_start = 0;
  uint32_t oversampled_start = 0;
  uint32_t oversampled_end = 0;
  double maximum_absolute_input = 0.0;
  double maximum_envelope = 0.0;

  if (!float32_view(env, argv[0], &decoded, &decoded_length)
      || !float64_view(env, argv[1], &output, &output_length)
      || !float64_view(env, argv[2], &coefficients, &coefficient_length)
      || !uint32_arg(env, argv[3], &total_frames)
      || !uint32_arg(env, argv[4], &range_start)
      || !uint32_arg(env, argv[5], &range_end)
      || !uint32_arg(env, argv[6], &read_start)
      || !uint32_arg(env, argv[7], &oversampled_start)
      || !uint32_arg(env, argv[8], &oversampled_end)
      || !double_arg(env, argv[9], &maximum_absolute_input)
      || !double_arg(env, argv[10], &maximum_envelope)) {
    return fail(env, "limiter-envelope arguments have invalid closed shapes");
  }

  const uint32_t limiter_phases = 4U;
  const uint32_t limiter_taps_per_phase = 12U;
  const uint32_t maximum_range_frames = 65536U + 960U;
  if (total_frames == 0U
      || range_start > range_end || range_end > total_frames
      || range_end - range_start == 0U
      || range_end - range_start > maximum_range_frames
      || output_length != (size_t)(range_end - range_start)
      || decoded_length == 0U || decoded_length % 2U != 0U
      || coefficient_length != (size_t)limiter_phases * limiter_taps_per_phase
      || read_start > range_start
      || read_start + decoded_length / 2U > total_frames
      || read_start + decoded_length / 2U < range_end
      || oversampled_start > oversampled_end
      || oversampled_start % limiter_phases != 0U
      || oversampled_end % limiter_phases != 0U
      || maximum_absolute_input <= 0.0
      || maximum_envelope <= 0.0) {
    return fail(env, "limiter-envelope dimensions, bounds, or coefficient table are inconsistent");
  }
  const uintptr_t decoded_start = (uintptr_t)decoded;
  const uintptr_t decoded_end = decoded_start + decoded_length * sizeof(float);
  const uintptr_t output_start = (uintptr_t)output;
  const uintptr_t output_end = output_start + output_length * sizeof(double);
  const uintptr_t coefficient_start = (uintptr_t)coefficients;
  const uintptr_t coefficient_end = coefficient_start + coefficient_length * sizeof(double);
  if (decoded_end < decoded_start || output_end < output_start
      || coefficient_end < coefficient_start
      || (decoded_start < output_end && output_start < decoded_end)
      || (decoded_start < coefficient_end && coefficient_start < decoded_end)
      || (output_start < coefficient_end && coefficient_start < output_end)) {
    return fail(env, "limiter-envelope typed arrays must have separate non-overlapping ownership");
  }

  bool any_nonzero = false;
  for (size_t index = 0; index < decoded_length; index += 1U) {
    const double sample = (double)decoded[index];
    if (!isfinite(sample) || fabs(sample) > maximum_absolute_input) {
      return fail(env, "limiter-envelope input contains an invalid sample");
    }
    if (sample != 0.0) any_nonzero = true;
  }
  for (uint32_t frame = range_start; frame < range_end; frame += 1U) {
    const size_t local = (size_t)(frame - read_start) * 2U;
    output[frame - range_start] = fmax(
      fabs((double)decoded[local]),
      fabs((double)decoded[local + 1U])
    );
  }

  uint64_t fir_base_frames = 0U;
  if (any_nonzero) {
    const uint32_t first_base = oversampled_start / limiter_phases;
    const uint32_t final_base = oversampled_end / limiter_phases;
    fir_base_frames = (uint64_t)(final_base - first_base);
    for (uint32_t base_frame = first_base; base_frame < final_base; base_frame += 1U) {
      const uint32_t first_input = base_frame >= limiter_taps_per_phase - 1U
        ? base_frame - (limiter_taps_per_phase - 1U)
        : 0U;
      const uint32_t last_input = base_frame < total_frames ? base_frame : total_frames - 1U;
      const uint32_t source_frame_unclamped = base_frame >= 6U ? base_frame - 6U : 0U;
      const uint32_t source_frame = source_frame_unclamped < total_frames
        ? source_frame_unclamped
        : total_frames - 1U;
      for (uint32_t phase = 0U; phase < limiter_phases; phase += 1U) {
        double left = 0.0;
        double right = 0.0;
        uint32_t coefficient_row = base_frame - first_input;
        for (uint32_t input_frame = first_input;
             input_frame <= last_input;
             input_frame += 1U, coefficient_row -= 1U) {
          if (input_frame < read_start
              || input_frame - read_start >= decoded_length / 2U
              || coefficient_row >= limiter_taps_per_phase) {
            return fail(env, "limiter-envelope read window does not cover its exact convolution");
          }
          const size_t local = (size_t)(input_frame - read_start) * 2U;
          const double input_left = (double)decoded[local];
          const double input_right = (double)decoded[local + 1U];
          if (input_left == 0.0 && input_right == 0.0) continue;
          const double coefficient = coefficients[(size_t)coefficient_row * limiter_phases + phase];
          left += input_left * coefficient;
          right += input_right * coefficient;
        }
        if (source_frame < range_start || source_frame >= range_end) continue;
        const double peak = fmax(fabs(left), fabs(right));
        if (!isfinite(peak) || peak > maximum_envelope) {
          return fail(env, "limiter-envelope result exceeds its admitted finite bound");
        }
        const size_t output_index = source_frame - range_start;
        if (peak > output[output_index]) output[output_index] = peak;
      }
    }
  }

  napi_value result;
  if (napi_create_object(env, &result) != napi_ok
      || !set_bigint_property(env, result, "frames", range_end - range_start)
      || !set_bigint_property(env, result, "firBaseFrames", fir_base_frames)) {
    return fail(env, "could not publish limiter-envelope counters");
  }
  return result;
}

/* Exact alpha-support scan for immutable straight RGBA8 bytes. The JavaScript
 * fallback remains normative on unsupported platforms; this native path only
 * removes per-pixel JS dispatch on the authenticated Darwin arm64 backend. */
static napi_value derive_rgba_alpha_bounds(
  napi_env env,
  napi_callback_info info
) {
  size_t argc = 3U;
  napi_value argv[3];
  uint8_t *source = NULL;
  size_t source_length = 0U;
  uint32_t width = 0U;
  uint32_t height = 0U;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok
      || argc != 3U
      || !uint8_view(env, argv[0], &source, &source_length)
      || !uint32_arg(env, argv[1], &width)
      || !uint32_arg(env, argv[2], &height)) {
    return fail(env, "alpha-bounds arguments have invalid closed shapes");
  }
  const uint64_t pixels = (uint64_t)width * (uint64_t)height;
  if (width == 0U || height == 0U || pixels > 67108864U
      || source_length != (size_t)pixels * 4U) {
    return fail(env, "alpha-bounds dimensions exceed the exact RGBA boundary");
  }

  uint32_t left = width;
  uint32_t top = height;
  uint32_t right = 0U;
  uint32_t bottom = 0U;
  uint64_t nonzero = 0U;
  for (uint32_t y = 0U; y < height; y += 1U) {
    for (uint32_t x = 0U; x < width; x += 1U) {
      const size_t offset = ((size_t)y * width + x) * 4U;
      if (source[offset + 3U] == 0U) continue;
      nonzero += 1U;
      if (x < left) left = x;
      if (x + 1U > right) right = x + 1U;
      if (y < top) top = y;
      if (y + 1U > bottom) bottom = y + 1U;
    }
  }
  const bool empty = nonzero == 0U;
  if (empty) left = top = right = bottom = 0U;
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok
      || !set_boolean_property(env, result, "empty", empty)
      || !set_bigint_property(env, result, "left", left)
      || !set_bigint_property(env, result, "top", top)
      || !set_bigint_property(env, result, "right", right)
      || !set_bigint_property(env, result, "bottom", bottom)
      || !set_bigint_property(env, result, "nonzeroAlphaPixels", nonzero)) {
    return fail(env, "could not publish alpha-bounds counters");
  }
  return result;
}

/* Copy RGB, apply CUT's exact positive Math.round alpha law, clear hidden RGB
 * when rounded coverage reaches zero, and derive support in the same bounded
 * pass. Output ownership must be distinct and is cleared before execution. */
static napi_value scale_retained_alpha(
  napi_env env,
  napi_callback_info info
) {
  size_t argc = 9U;
  napi_value argv[9];
  uint8_t *source = NULL;
  uint8_t *output = NULL;
  size_t source_length = 0U;
  size_t output_length = 0U;
  uint32_t width = 0U;
  uint32_t height = 0U;
  uint32_t left = 0U;
  uint32_t top = 0U;
  uint32_t right = 0U;
  uint32_t bottom = 0U;
  double opacity = 0.0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok
      || argc != 9U
      || !uint8_view(env, argv[0], &source, &source_length)
      || !uint8_view(env, argv[1], &output, &output_length)
      || !uint32_arg(env, argv[2], &width)
      || !uint32_arg(env, argv[3], &height)
      || !uint32_arg(env, argv[4], &left)
      || !uint32_arg(env, argv[5], &top)
      || !uint32_arg(env, argv[6], &right)
      || !uint32_arg(env, argv[7], &bottom)
      || !double_arg(env, argv[8], &opacity)) {
    return fail(env, "retained-alpha arguments have invalid closed shapes");
  }
  const uint64_t pixels = (uint64_t)width * (uint64_t)height;
  const uintptr_t source_start = (uintptr_t)source;
  const uintptr_t source_end = source_start + source_length;
  const uintptr_t output_start = (uintptr_t)output;
  const uintptr_t output_end = output_start + output_length;
  if (width == 0U || height == 0U || pixels > 67108864U
      || source_length != (size_t)pixels * 4U
      || output_length != source_length
      || left > right || top > bottom || right > width || bottom > height
      || opacity <= 0.0 || opacity >= 1.0
      || source_end < source_start || output_end < output_start
      || (source_start < output_end && output_start < source_end)) {
    return fail(env, "retained-alpha dimensions, bounds, opacity, or ownership are invalid");
  }
  memset(output, 0, output_length);
  uint32_t support_left = width;
  uint32_t support_top = height;
  uint32_t support_right = 0U;
  uint32_t support_bottom = 0U;
  uint64_t nonzero = 0U;
  for (uint32_t y = top; y < bottom; y += 1U) {
    for (uint32_t x = left; x < right; x += 1U) {
      const size_t offset = ((size_t)y * width + x) * 4U;
      const uint8_t alpha = rounded_clamped_255((double)source[offset + 3U] * opacity);
      if (alpha == 0U) continue;
      output[offset] = source[offset];
      output[offset + 1U] = source[offset + 1U];
      output[offset + 2U] = source[offset + 2U];
      output[offset + 3U] = alpha;
      nonzero += 1U;
      if (x < support_left) support_left = x;
      if (x + 1U > support_right) support_right = x + 1U;
      if (y < support_top) support_top = y;
      if (y + 1U > support_bottom) support_bottom = y + 1U;
    }
  }
  const bool empty = nonzero == 0U;
  if (empty) support_left = support_top = support_right = support_bottom = 0U;
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok
      || !set_boolean_property(env, result, "empty", empty)
      || !set_bigint_property(env, result, "left", support_left)
      || !set_bigint_property(env, result, "top", support_top)
      || !set_bigint_property(env, result, "right", support_right)
      || !set_bigint_property(env, result, "bottom", support_bottom)
      || !set_bigint_property(env, result, "nonzeroAlphaPixels", nonzero)) {
    return fail(env, "could not publish retained-alpha counters");
  }
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value composite_function;
  napi_value raster_function;
  napi_value limiter_envelope_function;
  napi_value alpha_bounds_function;
  napi_value scale_alpha_function;
  napi_value scale_translation_function;
  napi_value retained_translation_function;
  if (napi_create_function(env, "compositeNormalStraightInPlace", NAPI_AUTO_LENGTH, composite, NULL, &composite_function) != napi_ok
      || napi_set_named_property(env, exports, "compositeNormalStraightInPlace", composite_function) != napi_ok
      || napi_create_function(env, "rasterRetainedMediaViewport", NAPI_AUTO_LENGTH, raster_retained_media_viewport, NULL, &raster_function) != napi_ok
      || napi_set_named_property(env, exports, "rasterRetainedMediaViewport", raster_function) != napi_ok
      || napi_create_function(env, "deriveLimiterEnvelopeRange", NAPI_AUTO_LENGTH, derive_limiter_envelope_range, NULL, &limiter_envelope_function) != napi_ok
      || napi_set_named_property(env, exports, "deriveLimiterEnvelopeRange", limiter_envelope_function) != napi_ok
      || napi_create_function(env, "deriveRgbaAlphaBounds", NAPI_AUTO_LENGTH, derive_rgba_alpha_bounds, NULL, &alpha_bounds_function) != napi_ok
      || napi_set_named_property(env, exports, "deriveRgbaAlphaBounds", alpha_bounds_function) != napi_ok
      || napi_create_function(env, "scaleRetainedAlpha", NAPI_AUTO_LENGTH, scale_retained_alpha, NULL, &scale_alpha_function) != napi_ok
      || napi_set_named_property(env, exports, "scaleRetainedAlpha", scale_alpha_function) != napi_ok
      || napi_create_function(env, "rasterLocalSpaceScaleTranslationQ16", NAPI_AUTO_LENGTH, raster_local_space_scale_translation_q16, NULL, &scale_translation_function) != napi_ok
      || napi_set_named_property(env, exports, "rasterLocalSpaceScaleTranslationQ16", scale_translation_function) != napi_ok
      || napi_create_function(env, "translateRetainedSurfaceQ16", NAPI_AUTO_LENGTH, translate_retained_surface_q16, NULL, &retained_translation_function) != napi_ok
      || napi_set_named_property(env, exports, "translateRetainedSurfaceQ16", retained_translation_function) != napi_ok) {
    return fail(env, "could not initialize the native source-over prototype");
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
