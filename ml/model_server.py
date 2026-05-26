"""
ml/model_server.py

Simple Flask model server for serving ML predictions to TypeScript engine.
Provides HTTP bridge for the trading engine to call trained XGBoost/NN models.

Usage:
  python ml/model_server.py --port 5000

Then engine calls: POST http://localhost:5000/predict
"""

import logging
from typing import Any, Dict, List
import numpy as np
import json

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('model_server')

try:
    from flask import Flask, request, jsonify
    HAS_FLASK = True
except ImportError:
    HAS_FLASK = False
    logger.warning('Flask not available; model server will not start')

# Try to load trained models
try:
    import joblib
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False
    logger.warning('XGBoost not available')

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    logger.warning('PyTorch not available')


class ModelServer:
    """Wrapper for serving ML model predictions."""
    
    def __init__(self, model_dir: str = './ml/saved_models'):
        self.model_dir = model_dir
        self.xgb_model = None
        self.nn_model = None
        self.feature_names = None
        self.norm_params = None
        self.load_models()
    
    def load_models(self) -> None:
        """Load pre-trained models from disk."""
        try:
            if HAS_XGB:
                try:
                    self.xgb_model = xgb.Booster(model_file=f'{self.model_dir}/xgb_model.json')
                    logger.info('✓ Loaded XGBoost model')
                except Exception as e:
                    logger.warning(f'Could not load XGBoost model: {e}')
            
            if HAS_TORCH:
                try:
                    # Load NN model (architecture + weights)
                    self.nn_model = torch.load(f'{self.model_dir}/nn_model.pt')
                    self.nn_model.eval()
                    logger.info('✓ Loaded NN model')
                except Exception as e:
                    logger.warning(f'Could not load NN model: {e}')
            
            # Load normalization parameters
            try:
                norm_data = np.load(f'{self.model_dir}/norm_params.npz')
                self.norm_params = {
                    'means': norm_data['means'],
                    'stds': norm_data['stds'],
                }
                logger.info('✓ Loaded normalization parameters')
            except Exception as e:
                logger.warning(f'Could not load norm params: {e}')
            
            # Load feature names
            try:
                import json
                with open(f'{self.model_dir}/training_summary.json', 'r') as f:
                    summary = json.load(f)
                    self.feature_names = summary.get('feature_names', [])
                    logger.info(f'✓ Loaded {len(self.feature_names)} feature names')
            except Exception as e:
                logger.warning(f'Could not load feature names: {e}')
        
        except Exception as e:
            logger.error(f'Error loading models: {e}')
    
    def normalize_features(self, features: List[float]) -> np.ndarray:
        """Normalize features using stored means/stds."""
        if not self.norm_params:
            return np.array(features)
        
        features_arr = np.array(features)
        means = self.norm_params['means']
        stds = self.norm_params['stds']
        
        # Clip stds to avoid division by zero
        stds = np.maximum(stds, 1e-6)
        
        normalized = (features_arr - means) / stds
        # Clip to ±5 standard deviations
        normalized = np.clip(normalized, -5, 5)
        return normalized
    
    def predict(self, features: List[float]) -> Dict[str, float]:
        """
        Generate multi-target predictions for token signal.
        
        Args:
            features: 18-element list of normalized token signal features
        
        Returns:
            {
              'expectedReturn': float,      # -1 to +2 (regression)
              'rugProbability': float,      # 0 to 1 (classification)
              'volatilityEdge': float,      # -1 to +1
              'confidence': float,          # 0 to 1
            }
        """
        try:
            normalized = self.normalize_features(features)
            
            # Try XGBoost first
            if self.xgb_model:
                try:
                    predictions = self.xgb_model.predict(
                        xgb.DMatrix(normalized.reshape(1, -1))
                    )
                    # Assume XGBoost outputs 4 values: [expectedReturn, rugProb, edge, confidence]
                    return self._format_predictions(predictions[0])
                except Exception as e:
                    logger.warning(f'XGBoost prediction failed: {e}')
            
            # Fallback to NN
            if self.nn_model and HAS_TORCH:
                try:
                    with torch.no_grad():
                        input_tensor = torch.from_numpy(normalized).float().unsqueeze(0)
                        output = self.nn_model(input_tensor)
                        return self._format_predictions(output[0].numpy())
                except Exception as e:
                    logger.warning(f'NN prediction failed: {e}')
            
            # Fallback: heuristic
            return self._heuristic_predict(features)
        
        except Exception as e:
            logger.error(f'Predict error: {e}')
            return self._heuristic_predict(features)
    
    @staticmethod
    def _format_predictions(raw_output: np.ndarray) -> Dict[str, float]:
        """Convert model outputs to prediction interface."""
        if len(raw_output) >= 4:
            expected_return = float(raw_output[0])
            rug_prob = float(np.clip(raw_output[1], 0, 1))  # Sigmoid-like
            volatility_edge = float(raw_output[2])
            confidence = float(np.clip(raw_output[3], 0, 1))  # Sigmoid-like
        else:
            # Fallback if model doesn't output 4 values
            expected_return = float(raw_output[0]) if len(raw_output) > 0 else 0.0
            rug_prob = 0.1
            volatility_edge = 0.01
            confidence = 0.5
        
        return {
            'expectedReturn': expected_return,
            'rugProbability': rug_prob,
            'volatilityAdjustedEdge': volatility_edge,
            'confidence': confidence,
        }
    
    @staticmethod
    def _heuristic_predict(features: List[float]) -> Dict[str, float]:
        """Fallback heuristic prediction when models unavailable."""
        logger.warning('Using heuristic predictions')
        
        # Assume features: [liquiditySol, uniqueBuyers, priceGrowth1s, ...]
        if len(features) < 3:
            return {
                'expectedReturn': 0.0,
                'rugProbability': 0.2,
                'volatilityAdjustedEdge': 0.0,
                'confidence': 0.3,
            }
        
        liquidity_sol = max(0, features[0])
        unique_buyers = max(0, features[1])
        price_growth = features[2]
        
        # Heuristic: more liquidity, more buyers = better
        expected_return = min(0.5, 0.1 + unique_buyers / 50 + price_growth / 2)
        rug_prob = max(0.05, 1 / (1 + unique_buyers / 10))
        volatility_edge = expected_return - 0.05  # Simple adjustment
        confidence = min(1.0, 0.3 + unique_buyers / 30)
        
        return {
            'expectedReturn': expected_return,
            'rugProbability': rug_prob,
            'volatilityAdjustedEdge': volatility_edge,
            'confidence': confidence,
        }


# Flask app (only if Flask available)
if HAS_FLASK:
    app = Flask(__name__)
    model_server = ModelServer()
    
    @app.route('/predict', methods=['POST'])
    def predict():
        """HTTP endpoint for predictions."""
        try:
            data = request.get_json()
            features = data.get('features', [])
            
            if not isinstance(features, list) or len(features) != 18:
                return jsonify({
                    'error': f'Expected 18 features, got {len(features) if isinstance(features, list) else 0}'
                }), 400
            
            prediction = model_server.predict(features)
            return jsonify(prediction)
        
        except Exception as e:
            logger.error(f'Error in /predict: {e}')
            return jsonify({'error': str(e)}), 500
    
    @app.route('/health', methods=['GET'])
    def health():
        """Health check endpoint."""
        return jsonify({
            'status': 'ok',
            'has_xgb': model_server.xgb_model is not None,
            'has_nn': model_server.nn_model is not None,
            'has_norm_params': model_server.norm_params is not None,
        })


def main():
    """Start model server."""
    import argparse
    
    parser = argparse.ArgumentParser(description='Model server for trading engine')
    parser.add_argument('--port', type=int, default=5000, help='Port to listen on')
    parser.add_argument('--model-dir', type=str, default='./ml/saved_models', help='Directory with saved models')
    args = parser.parse_args()
    
    if not HAS_FLASK:
        logger.error('Flask is required. Install: pip install flask')
        return
    
    logger.info(f'Starting model server on http://localhost:{args.port}')
    app.run(host='0.0.0.0', port=args.port, debug=False, threaded=True)


if __name__ == '__main__':
    main()
