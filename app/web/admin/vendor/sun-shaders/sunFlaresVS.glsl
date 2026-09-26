#ifdef GL_ES
precision highp float;
#endif

attribute vec3 aPos;         
attribute vec3 aPos0;        
attribute vec3 aPos1;        
attribute vec4 aWireRandom;  

varying float vUVY;
varying float vOpacity;
varying vec3  vColor;
varying vec3  vNormal;       

uniform float uWidth;
uniform float uAmp;
uniform float uTime;
uniform float uNoiseFrequency;
uniform float uNoiseAmplitude;
uniform vec3  uCamPos;       
uniform mat4  uViewProjection;
uniform float uOpacity;
uniform float uHueSpread;
uniform float uHue;

#define m4  mat4( 0.00, 0.80, 0.60, -0.4, \
                 -0.80, 0.36, -0.48, -0.5, \
                 -0.60, -0.48, 0.64, 0.2,  \
                  0.40, 0.30, 0.20, 0.4)

vec4 twistedSineNoise(vec4 q, float falloff){
  float a = 1.0;
  float f = 1.0;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    q = m4 * q;
    vec4 s = sin(q.ywxz * f) * a;
    q += s;
    sum += s;
    a *= falloff;
    f /= falloff;
  }
  return sum;
}

vec3 getPosOBJ(float phase, float animPhase){
  
  float size = distance(aPos0, aPos1);
  vec3  n    = normalize((aPos0 + aPos1) * 0.5);

  vec3 p = mix(aPos0, aPos1, phase);

  float amp = sin(phase * 3.14159265) * size * uAmp;
  amp *= animPhase;

  p += n * amp;

  
  p += twistedSineNoise(vec4(p * uNoiseFrequency, uTime), 0.707).xyz
       * (amp * uNoiseAmplitude);

  return p;
}

#define hue(v) ( .6 + .6 * cos( 6.3*(v) + vec3(0.0,23.0,21.0) ) )

void main(void){
  vUVY = aPos.z;

  
  float animPhase = fract(uTime * 0.3 * (aWireRandom.y * 0.5) + aWireRandom.x);

  
  vec3 pOBJ  = getPosOBJ(aPos.x,        animPhase);
  vec3 p1OBJ = getPosOBJ(aPos.x + 0.01, animPhase);

  
  vec3 pW  = (modelMatrix * vec4(pOBJ , 1.0)).xyz;
  vec3 p1W = (modelMatrix * vec4(p1OBJ, 1.0)).xyz;

  vec3 dirW  = normalize(p1W - pW);
  vec3 vW    = normalize(pW - uCamPos);
  vec3 sideW = normalize(cross(vW, dirW));

  
  float R = length(aPos0);

  float width = uWidth * aPos.z * (1.0 + animPhase) * R;

  
  pW += sideW * width;

  
  vNormal  = normalize(pW);

  
  float lenW = length(pW);
  vOpacity  = smoothstep(R, R * 1.03, lenW);
  vOpacity *= (1.0 - animPhase);
  vOpacity *= uOpacity;

  vColor = hue(aWireRandom.w * uHueSpread + uHue);

  gl_Position = uViewProjection * vec4(pW, 1.0);
}