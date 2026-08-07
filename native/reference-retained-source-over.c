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

static bool uint32_arg(napi_env env, napi_value value, uint32_t *result) {
  return napi_get_value_uint32(env, value, result) == napi_ok;
}

static bool double_arg(napi_env env, napi_value value, double *result) {
  return napi_get_value_double(env, value, result) == napi_ok
    && isfinite(*result);
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

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value composite_function;
  napi_value raster_function;
  if (napi_create_function(env, "compositeNormalStraightInPlace", NAPI_AUTO_LENGTH, composite, NULL, &composite_function) != napi_ok
      || napi_set_named_property(env, exports, "compositeNormalStraightInPlace", composite_function) != napi_ok
      || napi_create_function(env, "rasterRetainedMediaViewport", NAPI_AUTO_LENGTH, raster_retained_media_viewport, NULL, &raster_function) != napi_ok
      || napi_set_named_property(env, exports, "rasterRetainedMediaViewport", raster_function) != napi_ok) {
    return fail(env, "could not initialize the native source-over prototype");
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
