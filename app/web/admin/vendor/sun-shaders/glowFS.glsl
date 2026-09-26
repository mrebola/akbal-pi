precision highp float;

uniform float uVisibility;
uniform float uDirection;
uniform vec3  uLightView;

float getAlpha(vec3 n){
  float nDotL = dot(n, uLightView) * uDirection;
  return smoothstep(1.0, 1.5, nDotL + uVisibility * 2.5);
}

varying float vRadial;
varying vec3 vWorld;

uniform float uTint;
uniform float uBrightness;
uniform float uFalloffColor;

vec3 brightnessToColor(float b){
  b *= uTint;
  return (vec3(b, b*b, b*b*b*b) / (uTint)) * uBrightness;
}

void main(void){
    float alpha = (1.0 - vRadial);
    alpha *= alpha;
    float brightness = 1.0 + alpha * uFalloffColor;
    alpha *= getAlpha(normalize(vWorld));
    gl_FragColor.xyz = brightnessToColor(brightness) * alpha;
    gl_FragColor.w = alpha;
   
}