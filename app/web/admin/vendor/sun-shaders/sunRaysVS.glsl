attribute vec3 aPos;
attribute vec3 aPos0;
attribute vec4 aWireRandom;

varying float vUVY;
varying float vOpacity;
varying vec3 vColor;
varying vec3 vNormal;

uniform float uHueSpread;
uniform float uHue;
uniform float uLength;
uniform float uWidth;
uniform float uTime;
uniform float uNoiseFrequency;
uniform float uNoiseAmplitude;
uniform vec3  uCamPos;
uniform mat4  uViewProjection;
uniform float uOpacity;

#define m4  mat4( 0.00, 0.80, 0.60, -0.4, -0.80,  0.36, -0.48, -0.5, -0.60, -0.48, 0.64, 0.2, 0.40, 0.30, 0.20,0.4)

vec4 twistedSineNoise(vec4 q, float falloff)
{
    float a = 1.;
    float f = 1.;
    vec4 sum = vec4(0);
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

vec3 getPos(float phase, float animPhase)
{
    float size = aWireRandom.z + 0.2;
    float d = phase * uLength * size;
    vec3 p = aPos0 + aPos0 * d;
    p += twistedSineNoise(vec4(p * uNoiseFrequency, uTime), 0.707).xyz * (d * uNoiseAmplitude);
    return p;
}

vec3 spectrum(in float d)
{
    return smoothstep(0.25, 0., abs(d + vec3(-0.375, -0.5, -0.625)));
}

void main(void) {
    vUVY = aPos.z;

    float animPhase = fract(uTime * 0.3 * (aWireRandom.y * 0.5) + aWireRandom.x);

    
    vec3 p  = getPos(aPos.x,        animPhase);
    vec3 p1 = getPos(aPos.x + 0.01, animPhase);

    
    vec3 p0w = (modelMatrix * vec4(p , 1.0)).xyz;
    vec3 p1w = (modelMatrix * vec4(p1, 1.0)).xyz;

    
    vec3 dirW  = normalize(p1w - p0w);
    vec3 vW    = normalize(p0w - uCamPos);
    vec3 sideW = normalize(cross(vW, dirW));

    
    if (length(sideW) < 1e-6) {
        vec3 up = (abs(dirW.y) < 0.99) ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
        sideW = normalize(cross(up, dirW));
    }

    float width = uWidth * aPos.z * (1.0 - aPos.x);

    
    vec3 pWorld = p0w + sideW * width;

    
    vNormal  = normalize(pWorld);

    vOpacity = uOpacity * (0.5 + aWireRandom.w);
    vColor   = spectrum(aWireRandom.w * uHueSpread + uHue);

    gl_Position = uViewProjection * vec4(pWorld, 1.0);
}