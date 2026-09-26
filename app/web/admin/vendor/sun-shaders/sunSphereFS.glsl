precision highp float;

uniform float uVisibility;
uniform float uDirection;
uniform vec3  uLightView;

float getAlpha(vec3 n){
  float nDotL = dot(n, uLightView) * uDirection;
  return smoothstep(1.0, 1.5, nDotL + uVisibility * 2.5);
}

varying vec3 vWorld;
varying vec3 vNormalView;
varying vec3 vNormalWorld;   
varying vec3 vLayer0;
varying vec3 vLayer1;
varying vec3 vLayer2;

uniform samplerCube uPerlinCube;

uniform float uFresnelPower;
uniform float uFresnelInfluence;
uniform float uTint;
uniform float uBase;
uniform float uBrightnessOffset;
uniform float uBrightness;

vec3 brightnessToColor(float b){
  b *= uTint;
  return (vec3(b, b*b, b*b*b*b) / uTint) * uBrightness;
}

float ocean(){
    float s = 0.0;
    s += textureCube(uPerlinCube, vLayer0).r;
    s += textureCube(uPerlinCube, vLayer1).r;
    s += textureCube(uPerlinCube, vLayer2).r;
    return s * 0.3333333;
}

void main(){
    
    vec3 Vview = normalize((viewMatrix * vec4(vWorld - cameraPosition, 0.0)).xyz);
    float nDotV = dot(vNormalView, -Vview);
    float fresnel = pow(1.0 - nDotV, uFresnelPower) * uFresnelInfluence;

    float brightness = ocean() * uBase + uBrightnessOffset + fresnel;
    vec3 col = clamp(brightnessToColor(brightness), 0.0, 1.0);

    
    float a = getAlpha(normalize(vNormalWorld));

    gl_FragColor = vec4(col, a);

}